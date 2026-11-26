import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createLspMessageReader, encodeLspMessage } from "./framing";
import { type LspConnection, LspMultiplexer } from "./multiplexer";
import type { LspLanguage, ServerCommand } from "./servers";

export interface LanguageServerProcess {
	send: (json: string) => void;
	/** Asks the server to exit, then kills it if it does not. */
	stop: () => void;
}

export interface SpawnedServerHandlers {
	onMessage: (json: string) => void;
	onExit: () => void;
}

export type SpawnLanguageServer = (
	command: ServerCommand,
	cwd: string,
	handlers: SpawnedServerHandlers,
) => LanguageServerProcess;

export interface LspServerPoolOptions {
	resolveCommand: (
		language: LspLanguage,
		worktreePath: string,
	) => ServerCommand | null;
	spawnServer?: SpawnLanguageServer;
	idleMs?: number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

interface PooledServer {
	multiplexer: LspMultiplexer;
	serverProcess: LanguageServerProcess;
	onServerExit: Set<() => void>;
	idleTimer: unknown;
}

export const LSP_IDLE_MS = 5 * 60_000;

export class LspServerPool {
	private readonly servers = new Map<string, PooledServer>();
	private readonly spawnServer: SpawnLanguageServer;
	private readonly idleMs: number;
	private readonly setTimer: NonNullable<LspServerPoolOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<LspServerPoolOptions["clearTimer"]>;

	constructor(private readonly options: LspServerPoolOptions) {
		this.spawnServer = options.spawnServer ?? spawnLanguageServer;
		this.idleMs = options.idleMs ?? LSP_IDLE_MS;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer =
			options.clearTimer ??
			((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	/** Null when no server is available for this language. */
	connect(
		worktreePath: string,
		language: LspLanguage,
		send: (json: string) => void,
		onServerExit: () => void,
	): LspConnection | null {
		const key = `${language}\0${worktreePath}`;
		const server =
			this.servers.get(key) ?? this.start(key, worktreePath, language);
		if (!server) return null;
		if (server.idleTimer !== undefined) {
			this.clearTimer(server.idleTimer);
			server.idleTimer = undefined;
		}
		const connection = server.multiplexer.connect(send);
		server.onServerExit.add(onServerExit);
		return {
			receive: connection.receive,
			close: () => {
				connection.close();
				server.onServerExit.delete(onServerExit);
				if (server.multiplexer.connectionCount > 0) return;
				if (this.servers.get(key) !== server) return;
				server.idleTimer = this.setTimer(() => this.stop(key), this.idleMs);
			},
		};
	}

	dispose(): void {
		for (const key of [...this.servers.keys()]) this.stop(key);
	}

	private start(
		key: string,
		worktreePath: string,
		language: LspLanguage,
	): PooledServer | null {
		const command = this.options.resolveCommand(language, worktreePath);
		if (!command) return null;
		const rootUri = pathToFileURL(worktreePath).href;
		let server: PooledServer | undefined;
		const serverProcess = this.spawnServer(command, worktreePath, {
			onMessage: (json) => server?.multiplexer.handleServerMessage(json),
			onExit: () => {
				if (!server || this.servers.get(key) !== server) return;
				this.servers.delete(key);
				if (server.idleTimer !== undefined) this.clearTimer(server.idleTimer);
				for (const notify of server.onServerExit) notify();
			},
		});
		server = {
			serverProcess,
			onServerExit: new Set(),
			idleTimer: undefined,
			multiplexer: new LspMultiplexer({
				sendToServer: (json) => serverProcess.send(json),
				initializeParams: (params) => ({
					...params,
					processId: process.pid,
					rootUri,
					rootPath: worktreePath,
					workspaceFolders: [{ uri: rootUri, name: "workspace" }],
				}),
			}),
		};
		this.servers.set(key, server);
		return server;
	}

	private stop(key: string) {
		const server = this.servers.get(key);
		if (!server) return;
		this.servers.delete(key);
		if (server.idleTimer !== undefined) this.clearTimer(server.idleTimer);
		for (const notify of server.onServerExit) notify();
		server.serverProcess.stop();
	}
}

const STOP_GRACE_MS = 2_000;

function spawnLanguageServer(
	{ command, args }: ServerCommand,
	cwd: string,
	{ onMessage, onExit }: SpawnedServerHandlers,
): LanguageServerProcess {
	const child = spawn(command, args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const read = createLspMessageReader(onMessage);
	child.stdout.on("data", (chunk: Buffer) => {
		try {
			read(chunk);
		} catch (error) {
			console.error("[lsp] unreadable server output:", error);
			child.kill();
		}
	});
	let stopping = false;
	let stderrTail = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
	});
	child.stdin.on("error", () => {});
	child.on("error", (error) => {
		console.error(`[lsp] could not start ${command}:`, error);
		onExit();
	});
	child.on("exit", (code, signal) => {
		if (!stopping && code !== 0 && stderrTail) {
			console.warn(`[lsp] ${command} exited (${code ?? signal}):`, stderrTail);
		}
		onExit();
	});
	const write = (message: object) => {
		if (child.stdin.writable)
			child.stdin.write(encodeLspMessage(JSON.stringify(message)));
	};
	return {
		send: (json) => {
			if (child.stdin.writable) child.stdin.write(encodeLspMessage(json));
		},
		stop: () => {
			stopping = true;
			write({ jsonrpc: "2.0", id: "host:shutdown", method: "shutdown" });
			write({ jsonrpc: "2.0", method: "exit" });
			setTimeout(() => {
				if (child.exitCode === null) child.kill();
			}, STOP_GRACE_MS).unref();
		},
	};
}
