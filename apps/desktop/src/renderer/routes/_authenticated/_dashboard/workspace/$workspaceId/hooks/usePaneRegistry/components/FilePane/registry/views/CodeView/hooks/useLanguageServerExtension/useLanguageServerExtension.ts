import type { Extension } from "@codemirror/state";
import { useWorkspaceClient, workspaceTrpc } from "@superset/workspace-client";
import { useEffect, useRef, useState } from "react";
import { loadLanguageServerExtension } from "renderer/routes/_authenticated/_dashboard/workspace/$workspaceId/utils/languageServer";
import { toAbsoluteWorkspacePath } from "shared/absolute-paths";

/** The editor extension for this file's language server, once one is connected. */
export function useLanguageServerExtension({
	workspaceId,
	filePath,
}: {
	workspaceId: string;
	filePath: string;
}): Extension | null {
	const { hostUrl, getWsToken } = useWorkspaceClient();
	const getWsTokenRef = useRef(getWsToken);
	getWsTokenRef.current = getWsToken;
	const worktreePath = workspaceTrpc.workspace.get.useQuery({
		id: workspaceId,
	}).data?.worktreePath;
	const [extension, setExtension] = useState<Extension | null>(null);

	useEffect(() => {
		setExtension(null);
		if (!worktreePath) return;
		let cancelled = false;
		void loadLanguageServerExtension({
			hostUrl,
			getWsToken: () => getWsTokenRef.current(),
			workspaceId,
			worktreePath,
			filePath: toAbsoluteWorkspacePath(worktreePath, filePath),
		}).then((loaded) => {
			if (!cancelled) setExtension(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, [hostUrl, workspaceId, worktreePath, filePath]);

	return extension;
}
