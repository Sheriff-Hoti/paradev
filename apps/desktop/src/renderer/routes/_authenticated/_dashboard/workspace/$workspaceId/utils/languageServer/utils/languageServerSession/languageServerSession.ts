import {
	LSPClient,
	languageServerExtensions,
	type Transport,
} from "@codemirror/lsp-client";
import { msg } from "@lingui/core/macro";
import { i18n } from "@superset/i18n";
import { toast } from "@superset/ui/sonner";
import {
	type LspLanguage,
	MAX_RECONNECTS,
	NO_SERVER_RETRY_MS,
	RECONNECT_RESET_AFTER_MS,
	REQUEST_TIMEOUT_MS,
	SOCKET_IDLE_CLOSE_MS,
} from "../../constants";
import { definitionClick } from "../definitionClick";
import { pathToFileUri } from "../fileUri";
import { PaneWorkspace } from "../PaneWorkspace";
import { pullDiagnostics } from "../pullDiagnostics";
import { sanitizeHtml } from "../sanitizeHtml";

export interface LanguageServerSessionOptions {
	hostUrl: string;
	getWsToken: () => string | null | undefined;
	workspaceId: string;
	worktreePath: string;
	language: LspLanguage;
	openFileInPane: (absolutePath: string) => boolean;
}

const sessions = new Map<string, LanguageServerSession>();
const hostsWithoutLspUntil = new Map<string, number>();

/** Null when this host has no language server for the language. */
export function getLanguageServerSession(
	options: LanguageServerSessionOptions,
): LanguageServerSession | null {
	const hostKey = `${options.hostUrl}\0${options.language}`;
	if ((hostsWithoutLspUntil.get(hostKey) ?? 0) > Date.now()) return null;
	const key = `${hostKey}\0${options.workspaceId}`;
	const existing = sessions.get(key);
	if (existing) return existing;
	const session = new LanguageServerSession(options, {
		onUnsupported: () =>
			hostsWithoutLspUntil.set(hostKey, Date.now() + NO_SERVER_RETRY_MS),
		onDispose: () => {
			if (sessions.get(key) === session) sessions.delete(key);
		},
	});
	sessions.set(key, session);
	return session;
}

interface SessionLifecycle {
	onUnsupported: () => void;
	onDispose: () => void;
}

/** One LSP client and socket per (host, workspace, language), shared by its editors. */
export class LanguageServerSession {
	readonly client: LSPClient;
	/** Resolves once the socket opened; rejects when the host has no server. */
	readonly ready: Promise<void>;
	private socket: WebSocket | null = null;
	private everOpened = false;
	private openedAt = 0;
	private reconnects = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private settleReady!: (error?: Error) => void;

	constructor(
		private readonly options: LanguageServerSessionOptions,
		private readonly lifecycle: SessionLifecycle,
	) {
		this.ready = new Promise<void>((resolve, reject) => {
			this.settleReady = (error) => (error ? reject(error) : resolve());
		});
		this.ready.catch(() => {});
		this.client = new LSPClient({
			rootUri: pathToFileUri(options.worktreePath),
			timeout: REQUEST_TIMEOUT_MS,
			sanitizeHTML: sanitizeHtml,
			workspace: (client) =>
				new PaneWorkspace(client, {
					worktreePath: options.worktreePath,
					openFileInPane: options.openFileInPane,
					onOutsideWorkspace: () =>
						toast.info(
							i18n._(
								msg({ message: "The definition is outside this workspace." }),
							),
						),
					onOpenFileCountChange: (count) => this.onOpenFileCountChange(count),
				}),
			extensions: [
				...languageServerExtensions(),
				pullDiagnostics,
				definitionClick,
			],
		});
		this.onOpenFileCountChange(0);
		this.connect();
	}

	private connect() {
		const url = new URL(
			`${this.options.hostUrl}/lsp/${encodeURIComponent(this.options.workspaceId)}/${this.options.language}`,
		);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const token = this.options.getWsToken();
		if (token) url.searchParams.set("token", token);

		const socket = new WebSocket(url.toString());
		this.socket = socket;
		const handlers = new Set<(message: string) => void>();
		const queued: string[] = [];
		const transport: Transport = {
			send: (message) => {
				if (socket.readyState === WebSocket.OPEN) socket.send(message);
				else if (socket.readyState === WebSocket.CONNECTING)
					queued.push(message);
				else throw new Error("Language server connection closed");
			},
			subscribe: (handler) => handlers.add(handler),
			unsubscribe: (handler) => handlers.delete(handler),
		};

		socket.onopen = () => {
			this.everOpened = true;
			this.openedAt = Date.now();
			for (const message of queued.splice(0)) socket.send(message);
			this.settleReady();
		};
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			for (const handler of handlers) handler(event.data);
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.client.disconnect();
			if (this.disposed) return;
			if (!this.everOpened) {
				console.info(
					`[lsp] ${this.options.hostUrl} has no ${this.options.language} language server; the editor works without one.`,
				);
				this.lifecycle.onUnsupported();
				this.dispose(new Error("No language server"));
				return;
			}
			if (Date.now() - this.openedAt > RECONNECT_RESET_AFTER_MS) {
				this.reconnects = 0;
			}
			if (this.reconnects >= MAX_RECONNECTS) {
				this.dispose(new Error("Language server unreachable"));
				return;
			}
			this.reconnects += 1;
			setTimeout(() => {
				if (!this.disposed) this.connect();
			}, 1_000 * this.reconnects);
		};

		this.client.connect(transport);
	}

	private onOpenFileCountChange(count: number) {
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (count > 0) return;
		this.idleTimer = setTimeout(() => this.dispose(), SOCKET_IDLE_CLOSE_MS);
	}

	private dispose(error?: Error) {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.idleTimer);
		this.settleReady(error ?? new Error("Language server session closed"));
		const socket = this.socket;
		this.socket = null;
		this.client.disconnect();
		socket?.close();
		this.lifecycle.onDispose();
	}
}
