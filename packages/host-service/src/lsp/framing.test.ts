import { describe, expect, test } from "bun:test";
import { createLspMessageReader, encodeLspMessage } from "./framing";

describe("LSP framing", () => {
	test("reads messages split across chunks and joined in one chunk", () => {
		const received: string[] = [];
		const read = createLspMessageReader((json) => received.push(json));
		const first = encodeLspMessage('{"id":1,"text":"héllo"}');
		const second = encodeLspMessage('{"id":2}');
		const stream = Buffer.concat([first, second]);

		read(stream.subarray(0, 5));
		read(stream.subarray(5, first.byteLength + 3));
		expect(received).toEqual(['{"id":1,"text":"héllo"}']);
		read(stream.subarray(first.byteLength + 3));
		expect(received).toEqual(['{"id":1,"text":"héllo"}', '{"id":2}']);
	});
});
