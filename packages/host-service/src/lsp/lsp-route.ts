import type { NodeWebSocket } from "@hono/node-ws";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { HostDb } from "../db/index.ts";
import { workspaces } from "../db/schema.ts";
import { getPathState } from "../runtime/path-state/index.ts";
import type { LspConnection } from "./multiplexer";
import type { LspServerPool } from "./server-pool";
import { isLspLanguage } from "./servers";

export interface RegisterLspRouteOptions {
	app: Hono;
	db: HostDb;
	pool: LspServerPool;
	upgradeWebSocket: NodeWebSocket["upgradeWebSocket"];
}

/** One socket carries the JSON-RPC of one (workspace, language) client. */
export function registerLspRoute({
	app,
	db,
	pool,
	upgradeWebSocket,
}: RegisterLspRouteOptions) {
	const findWorktreePath = (workspaceId: string): string | null => {
		const workspace = db.query.workspaces
			.findFirst({ where: eq(workspaces.id, workspaceId) })
			.sync();
		if (!workspace) return null;
		return getPathState(workspace.worktreePath) === "directory"
			? workspace.worktreePath
			: null;
	};

	app.get(
		"/lsp/:workspaceId/:language",
		async (c, next) => {
			const workspaceId = c.req.param("workspaceId") ?? "";
			const language = c.req.param("language") ?? "";
			if (!isLspLanguage(language)) {
				return c.json({ error: "Unsupported language" }, 404);
			}
			if (!findWorktreePath(workspaceId)) {
				return c.json({ error: "Workspace not found" }, 404);
			}
			return next();
		},
		upgradeWebSocket((c) => {
			const workspaceId = c.req.param("workspaceId") ?? "";
			const language = c.req.param("language") ?? "";
			const worktreePath = findWorktreePath(workspaceId);
			let connection: LspConnection | null = null;
			return {
				onOpen: (_event, ws) => {
					if (!worktreePath || !isLspLanguage(language)) {
						ws.close(1011, "workspace not found");
						return;
					}
					connection = pool.connect(
						worktreePath,
						language,
						(json) => ws.send(json),
						() => ws.close(1011, "language server exited"),
					);
					if (!connection) ws.close(1011, "no language server available");
				},
				onMessage: (event) => {
					if (typeof event.data !== "string") return;
					try {
						connection?.receive(event.data);
					} catch (error) {
						console.warn("[lsp] dropped an unreadable client message:", error);
					}
				},
				onClose: () => {
					connection?.close();
					connection = null;
				},
				onError: () => {
					connection?.close();
					connection = null;
				},
			};
		}),
	);
}
