import type { Extension } from "@codemirror/state";
import { lspDocumentFor, pathToFileUri } from "./utils/fileUri";
import { getLanguageServerSession } from "./utils/languageServerSession";

type FileOpener = (absolutePath: string) => void;

const fileOpeners = new Map<string, FileOpener>();

/** Lets go-to-definition open files in this workspace's panes. */
export function registerLanguageServerFileOpener(
	workspaceId: string,
	open: FileOpener,
): () => void {
	fileOpeners.set(workspaceId, open);
	return () => {
		if (fileOpeners.get(workspaceId) === open) fileOpeners.delete(workspaceId);
	};
}

export interface LanguageServerTarget {
	hostUrl: string;
	getWsToken: () => string | null | undefined;
	workspaceId: string;
	worktreePath: string;
	/** Absolute path of the file in the editor. */
	filePath: string;
}

/** Resolves to null when the file has no language server on this host. */
export async function loadLanguageServerExtension(
	target: LanguageServerTarget,
): Promise<Extension | null> {
	const document = lspDocumentFor(target.filePath);
	if (!document) return null;
	const session = getLanguageServerSession({
		hostUrl: target.hostUrl,
		getWsToken: target.getWsToken,
		workspaceId: target.workspaceId,
		worktreePath: target.worktreePath,
		language: document.language,
		openFileInPane: (absolutePath) => {
			const open = fileOpeners.get(target.workspaceId);
			open?.(absolutePath);
			return open !== undefined;
		},
	});
	if (!session) return null;
	try {
		await session.ready;
	} catch {
		return null;
	}
	return session.client.plugin(
		pathToFileUri(target.filePath),
		document.languageId,
	);
}
