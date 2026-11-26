import {
	type LSPClient,
	LSPPlugin,
	Workspace,
	type WorkspaceFile,
} from "@codemirror/lsp-client";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { isWithinWorkspacePath } from "shared/absolute-paths";
import { DISPLAY_FILE_TIMEOUT_MS } from "../../constants";
import { fileUriToPath, sameFileUri } from "../fileUri";

export interface PaneWorkspaceOptions {
	worktreePath: string;
	/** Opens the file in a pane of the workspace, or returns false when no pane can. */
	openFileInPane: (absolutePath: string) => boolean;
	onOutsideWorkspace: (path: string) => void;
	onOpenFileCountChange: (count: number) => void;
}

class PaneWorkspaceFile implements WorkspaceFile {
	views: EditorView[];

	constructor(
		readonly uri: string,
		readonly languageId: string,
		public version: number,
		public doc: Text,
		view: EditorView,
	) {
		this.views = [view];
	}

	/** The first view is the one whose edits are sent to the server. */
	get owner(): EditorView | undefined {
		return this.views[0];
	}

	getView(main?: EditorView): EditorView | null {
		if (main && this.views.includes(main)) return main;
		return this.owner ?? null;
	}
}

interface ViewWaiter {
	uri: string;
	resolve: (view: EditorView | null) => void;
}

/** Lets one LSP client serve every editor of a workspace, across panes. */
export class PaneWorkspace extends Workspace {
	files: PaneWorkspaceFile[] = [];
	private versions = new Map<string, number>();
	private waiters = new Set<ViewWaiter>();

	constructor(
		client: LSPClient,
		private readonly options: PaneWorkspaceOptions,
	) {
		super(client);
	}

	getFile(uri: string): PaneWorkspaceFile | null {
		return this.files.find((file) => sameFileUri(file.uri, uri)) ?? null;
	}

	syncFiles() {
		const updates = [];
		for (const file of this.files) {
			const [owner, ...others] = file.views;
			for (const view of others) LSPPlugin.get(view)?.clear();
			const plugin = owner && LSPPlugin.get(owner);
			if (!owner || !plugin || plugin.unsyncedChanges.empty) continue;
			updates.push({
				file,
				prevDoc: file.doc,
				changes: plugin.unsyncedChanges,
			});
			file.doc = owner.state.doc;
			file.version = this.nextVersion(file.uri);
			plugin.clear();
		}
		return updates;
	}

	openFile(uri: string, languageId: string, view: EditorView) {
		const existing = this.getFile(uri);
		if (existing) {
			if (!existing.views.includes(view)) existing.views.push(view);
		} else {
			const file = new PaneWorkspaceFile(
				uri,
				languageId,
				this.nextVersion(uri),
				view.state.doc,
				view,
			);
			this.files.push(file);
			if (this.client.connected) this.client.didOpen(file);
			this.options.onOpenFileCountChange(this.files.length);
		}
		for (const waiter of [...this.waiters]) {
			if (!sameFileUri(waiter.uri, uri)) continue;
			this.waiters.delete(waiter);
			afterLayout(() => waiter.resolve(view));
		}
	}

	closeFile(uri: string, view: EditorView) {
		const file = this.getFile(uri);
		if (!file) return;
		const wasOwner = file.owner === view;
		file.views = file.views.filter((candidate) => candidate !== view);
		const nextOwner = file.owner;
		if (!nextOwner) {
			this.files = this.files.filter((candidate) => candidate !== file);
			this.versions.delete(fileUriToPath(file.uri) ?? file.uri);
			if (this.client.connected) this.client.didClose(file.uri);
			this.options.onOpenFileCountChange(this.files.length);
			return;
		}
		if (!wasOwner) return;
		LSPPlugin.get(nextOwner)?.clear();
		file.doc = nextOwner.state.doc;
		file.version = this.nextVersion(file.uri);
		if (!this.client.connected) return;
		this.client.didClose(file.uri);
		this.client.didOpen(file);
	}

	async displayFile(uri: string): Promise<EditorView | null> {
		const path = fileUriToPath(uri);
		if (!path || !isWithinWorkspacePath(this.options.worktreePath, path)) {
			this.options.onOutsideWorkspace(path ?? uri);
			return null;
		}
		if (!this.options.openFileInPane(path)) return null;
		const open = this.getFile(uri)?.getView();
		if (open) return new Promise((resolve) => afterLayout(() => resolve(open)));
		return new Promise((resolve) => {
			const waiter: ViewWaiter = { uri, resolve };
			this.waiters.add(waiter);
			setTimeout(() => {
				if (this.waiters.delete(waiter)) resolve(null);
			}, DISPLAY_FILE_TIMEOUT_MS);
		});
	}

	private nextVersion(uri: string): number {
		const key = fileUriToPath(uri) ?? uri;
		const version = (this.versions.get(key) ?? -1) + 1;
		this.versions.set(key, version);
		return version;
	}
}

/** A new pane restores its saved scroll on the next frames; jump after that. */
function afterLayout(run: () => void) {
	requestAnimationFrame(() => requestAnimationFrame(run));
}
