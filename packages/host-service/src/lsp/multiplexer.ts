type RequestId = number | string;

interface Message {
	jsonrpc?: "2.0";
	id?: RequestId | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

export interface LspConnection {
	receive: (json: string) => void;
	close: () => void;
}

interface ConnectionState {
	send: (json: string) => void;
	openUris: Set<string>;
}

interface PendingClientRequest {
	connection: ConnectionState;
	clientId: RequestId;
}

interface PendingServerRequest {
	connection: ConnectionState;
	serverId: RequestId;
}

export interface LspMultiplexerOptions {
	sendToServer: (json: string) => void;
	/** Overrides the first client's initialize params, so the root is the host's worktree. */
	initializeParams: (
		clientParams: Record<string, unknown>,
	) => Record<string, unknown>;
}

const LOCALLY_ANSWERED_SERVER_REQUESTS = new Set([
	"client/registerCapability",
	"client/unregisterCapability",
	"window/workDoneProgress/create",
]);

const INITIALIZE_ID = "host:initialize";

/**
 * Shares one language server between many client connections: the server
 * sees a single client that initializes once, never reuses a request id, and
 * opens each document once.
 */
export class LspMultiplexer {
	private readonly connections = new Set<ConnectionState>();
	private readonly clientRequests = new Map<RequestId, PendingClientRequest>();
	private readonly serverRequests = new Map<string, PendingServerRequest>();
	private readonly openCounts = new Map<string, number>();
	private initializeResponse: Message | undefined;
	private initializeWaiters: Array<(response: Message) => void> | null = null;
	private nextServerId = 1;
	private nextHostRequestId = 1;
	private lastActive: ConnectionState | null = null;

	constructor(private readonly options: LspMultiplexerOptions) {}

	get connectionCount(): number {
		return this.connections.size;
	}

	connect(send: (json: string) => void): LspConnection {
		const connection: ConnectionState = { send, openUris: new Set() };
		this.connections.add(connection);
		return {
			receive: (json) => this.handleClientMessage(connection, json),
			close: () => this.disconnect(connection),
		};
	}

	handleServerMessage(json: string): void {
		const message = JSON.parse(json) as Message;
		if (message.method !== undefined && message.id !== undefined) {
			this.handleServerRequest(message);
		} else if (message.method !== undefined) {
			for (const connection of this.connections) connection.send(json);
		} else if (message.id === INITIALIZE_ID) {
			const waiters = this.initializeWaiters ?? [];
			this.initializeWaiters = null;
			if (!message.error) {
				this.initializeResponse = message;
				this.sendToServer({ method: "initialized", params: {} });
			}
			for (const reply of waiters) reply(message);
		} else if (message.id !== undefined && message.id !== null) {
			const pending = this.clientRequests.get(message.id);
			if (!pending) return;
			this.clientRequests.delete(message.id);
			sendTo(pending.connection, { ...message, id: pending.clientId });
		}
	}

	private handleClientMessage(connection: ConnectionState, json: string) {
		const message = JSON.parse(json) as Message;
		this.lastActive = connection;
		const { id, method } = message;

		if (method === undefined) {
			if (typeof id !== "string") return;
			const pending = this.serverRequests.get(id);
			if (!pending) return;
			this.serverRequests.delete(id);
			this.sendToServer({ ...message, id: pending.serverId });
			return;
		}

		switch (method) {
			case "initialize":
				this.initialize(connection, id ?? null, message.params);
				return;
			case "initialized":
			case "exit":
				return;
			case "shutdown":
				sendTo(connection, { id, result: null });
				return;
			case "textDocument/didOpen":
				this.didOpen(connection, message);
				return;
			case "textDocument/didClose":
				this.didClose(connection, documentUri(message.params));
				return;
			case "$/cancelRequest":
				this.cancel(connection, message.params);
				return;
		}

		if (id === undefined || id === null) {
			this.sendToServer(message);
			return;
		}
		const serverId = this.nextServerId++;
		this.clientRequests.set(serverId, { connection, clientId: id });
		this.sendToServer({ ...message, id: serverId });
	}

	private initialize(
		connection: ConnectionState,
		clientId: RequestId | null,
		params: unknown,
	) {
		const reply = ({ result, error }: Message) => {
			sendTo(
				connection,
				error ? { id: clientId, error } : { id: clientId, result },
			);
		};
		if (this.initializeResponse) {
			reply(this.initializeResponse);
			return;
		}
		if (this.initializeWaiters) {
			this.initializeWaiters.push(reply);
			return;
		}
		this.initializeWaiters = [reply];
		this.sendToServer({
			id: INITIALIZE_ID,
			method: "initialize",
			params: this.options.initializeParams(
				(params ?? {}) as Record<string, unknown>,
			),
		});
	}

	private didOpen(connection: ConnectionState, message: Message) {
		const uri = documentUri(message.params);
		if (!uri || connection.openUris.has(uri)) return;
		connection.openUris.add(uri);
		const count = this.openCounts.get(uri) ?? 0;
		this.openCounts.set(uri, count + 1);
		if (count === 0) {
			this.sendToServer(message);
			return;
		}
		const document = (
			message.params as { textDocument: Record<string, unknown> }
		).textDocument;
		this.sendToServer({
			method: "textDocument/didChange",
			params: {
				textDocument: { uri, version: document.version },
				contentChanges: [{ text: document.text }],
			},
		});
	}

	private didClose(connection: ConnectionState, uri: string | undefined) {
		if (!uri || !connection.openUris.delete(uri)) return;
		const count = (this.openCounts.get(uri) ?? 1) - 1;
		if (count > 0) {
			this.openCounts.set(uri, count);
			return;
		}
		this.openCounts.delete(uri);
		this.sendToServer({
			method: "textDocument/didClose",
			params: { textDocument: { uri } },
		});
	}

	private cancel(connection: ConnectionState, params: unknown) {
		const clientId = (params as { id?: RequestId } | undefined)?.id;
		for (const [serverId, pending] of this.clientRequests) {
			if (pending.connection === connection && pending.clientId === clientId) {
				this.sendToServer({
					method: "$/cancelRequest",
					params: { id: serverId },
				});
				return;
			}
		}
	}

	private handleServerRequest(message: Message) {
		const serverId = message.id as RequestId;
		if (message.method === "workspace/configuration") {
			const items = (message.params as { items?: unknown[] } | undefined)
				?.items;
			this.sendToServer({
				id: serverId,
				result: (items ?? []).map(() => null),
			});
			return;
		}
		const target =
			this.lastActive && this.connections.has(this.lastActive)
				? this.lastActive
				: this.connections.values().next().value;
		if (LOCALLY_ANSWERED_SERVER_REQUESTS.has(message.method ?? "") || !target) {
			this.sendToServer({ id: serverId, result: null });
			return;
		}
		const hostId = `host:${this.nextHostRequestId++}`;
		this.serverRequests.set(hostId, { connection: target, serverId });
		sendTo(target, { ...message, id: hostId });
	}

	private disconnect(connection: ConnectionState) {
		if (!this.connections.delete(connection)) return;
		for (const uri of [...connection.openUris]) this.didClose(connection, uri);
		for (const [serverId, pending] of this.clientRequests) {
			if (pending.connection !== connection) continue;
			this.clientRequests.delete(serverId);
			this.sendToServer({
				method: "$/cancelRequest",
				params: { id: serverId },
			});
		}
		for (const [hostId, pending] of this.serverRequests) {
			if (pending.connection !== connection) continue;
			this.serverRequests.delete(hostId);
			this.sendToServer({ id: pending.serverId, result: null });
		}
		if (this.lastActive === connection) this.lastActive = null;
	}

	private sendToServer(message: Message) {
		this.options.sendToServer(JSON.stringify({ ...message, jsonrpc: "2.0" }));
	}
}

function sendTo(connection: ConnectionState, message: Message) {
	connection.send(JSON.stringify({ ...message, jsonrpc: "2.0" }));
}

function documentUri(params: unknown): string | undefined {
	return (params as { textDocument?: { uri?: string } } | undefined)
		?.textDocument?.uri;
}
