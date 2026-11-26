import { describe, expect, test } from "bun:test";
import { LspMultiplexer } from "./multiplexer";

type Json = Record<string, unknown>;

function setup() {
	const toServer: Json[] = [];
	const mux = new LspMultiplexer({
		sendToServer: (json) => toServer.push(JSON.parse(json)),
		initializeParams: (params) => ({ ...params, rootUri: "file:///root" }),
	});
	const client = () => {
		const received: Json[] = [];
		const connection = mux.connect((json) => received.push(JSON.parse(json)));
		const send = (message: Json) =>
			connection.receive(JSON.stringify({ jsonrpc: "2.0", ...message }));
		return { received, send, close: connection.close };
	};
	const fromServer = (message: Json) =>
		mux.handleServerMessage(JSON.stringify({ jsonrpc: "2.0", ...message }));
	return { mux, toServer, client, fromServer };
}

const methods = (messages: Json[]) => messages.map((m) => m.method);
const nth = (messages: Json[], index: number) => messages[index] as Json;

describe("LspMultiplexer", () => {
	test("initializes the server once and replays the result", () => {
		const { toServer, client, fromServer } = setup();
		const a = client();
		a.send({ id: 1, method: "initialize", params: { rootUri: "file:///x" } });
		const b = client();
		b.send({ id: 1, method: "initialize", params: {} });

		expect(toServer).toHaveLength(1);
		expect((nth(toServer, 0).params as Json).rootUri).toBe("file:///root");
		fromServer({
			id: nth(toServer, 0).id,
			result: { capabilities: { hover: true } },
		});
		const c = client();
		c.send({ id: 7, method: "initialize", params: {} });
		a.send({ method: "initialized", params: {} });

		expect(methods(toServer)).toEqual(["initialize", "initialized"]);
		for (const [conn, id] of [
			[a, 1],
			[b, 1],
			[c, 7],
		] as const) {
			expect(conn.received).toEqual([
				{ jsonrpc: "2.0", id, result: { capabilities: { hover: true } } },
			]);
		}
	});

	test("rewrites request ids so clients may reuse them", () => {
		const { toServer, client, fromServer } = setup();
		const a = client();
		const b = client();
		a.send({ id: 3, method: "textDocument/hover", params: {} });
		b.send({ id: 3, method: "textDocument/hover", params: {} });
		const first = nth(toServer, 0);
		const second = nth(toServer, 1);
		expect(first.id).not.toBe(second.id);

		fromServer({ id: second.id, result: "b" });
		fromServer({ id: first.id, result: "a" });
		expect(a.received).toEqual([{ jsonrpc: "2.0", id: 3, result: "a" }]);
		expect(b.received).toEqual([{ jsonrpc: "2.0", id: 3, result: "b" }]);
	});

	test("opens a document once and closes it when its last holder leaves", () => {
		const { toServer, client } = setup();
		const a = client();
		const b = client();
		const open = {
			method: "textDocument/didOpen",
			params: {
				textDocument: { uri: "file:///root/a.ts", version: 1, text: "x" },
			},
		};
		a.send(open);
		b.send(open);
		a.close();
		expect(methods(toServer)).toEqual([
			"textDocument/didOpen",
			"textDocument/didChange",
		]);
		b.close();
		expect(methods(toServer).at(-1)).toBe("textDocument/didClose");
	});

	test("answers server requests and drops a disconnected client's work", () => {
		const { toServer, client, fromServer } = setup();
		const a = client();
		a.send({ id: 1, method: "textDocument/definition", params: {} });
		fromServer({
			id: 40,
			method: "workspace/configuration",
			params: { items: [{}, {}] },
		});
		fromServer({ id: 41, method: "workspace/applyEdit", params: {} });
		const forwarded = a.received.at(-1) as Json;
		expect(forwarded.method).toBe("workspace/applyEdit");

		a.close();
		expect(toServer.slice(1)).toEqual([
			{ jsonrpc: "2.0", id: 40, result: [null, null] },
			{
				jsonrpc: "2.0",
				method: "$/cancelRequest",
				params: { id: nth(toServer, 0).id },
			},
			{ jsonrpc: "2.0", id: 41, result: null },
		]);
	});
});
