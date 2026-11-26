import { describe, expect, test } from "bun:test";
import { LspServerPool, type SpawnedServerHandlers } from "./server-pool";

function setup() {
	const spawned: Array<SpawnedServerHandlers & { stopped: boolean }> = [];
	const timers: Array<{ run: () => void; cleared: boolean }> = [];
	const pool = new LspServerPool({
		resolveCommand: () => ({ command: "tsc", args: ["--lsp"] }),
		spawnServer: (_command, _cwd, handlers) => {
			const server = { ...handlers, stopped: false };
			spawned.push(server);
			return {
				send: () => {},
				stop: () => {
					server.stopped = true;
				},
			};
		},
		idleMs: 10,
		setTimer: (run) => {
			const timer = { run, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer) => {
			(timer as { cleared: boolean }).cleared = true;
		},
	});
	const connect = (onExit = () => {}) =>
		pool.connect("/repo", "typescript", () => {}, onExit);
	return { pool, spawned, timers, connect };
}

describe("LspServerPool", () => {
	test("shares a server and stops it only after the idle period", () => {
		const { spawned, timers, connect } = setup();
		const a = connect();
		const b = connect();
		expect(spawned).toHaveLength(1);

		a?.close();
		expect(timers).toHaveLength(0);
		b?.close();
		expect(timers).toHaveLength(1);

		const c = connect();
		expect(timers[0]?.cleared).toBe(true);
		expect(spawned).toHaveLength(1);
		c?.close();
		timers[1]?.run();
		expect(spawned[0]?.stopped).toBe(true);

		connect();
		expect(spawned).toHaveLength(2);
	});

	test("tells connections when the server exits and starts fresh next time", () => {
		const { spawned, connect } = setup();
		let exits = 0;
		connect(() => exits++);
		spawned[0]?.onExit();
		expect(exits).toBe(1);
		connect();
		expect(spawned).toHaveLength(2);
	});
});
