const HEADER_END = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH = /^content-length:\s*(\d+)\s*$/im;

export function encodeLspMessage(json: string): Buffer {
	const body = Buffer.from(json, "utf8");
	return Buffer.concat([
		Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
		body,
	]);
}

/** Splits a Content-Length framed byte stream into message bodies. */
export function createLspMessageReader(onMessage: (json: string) => void) {
	let buffer: Buffer = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buffer = buffer.byteLength ? Buffer.concat([buffer, chunk]) : chunk;
		while (true) {
			const headerEnd = buffer.indexOf(HEADER_END);
			if (headerEnd < 0) return;
			const header = buffer.subarray(0, headerEnd).toString("ascii");
			const match = CONTENT_LENGTH.exec(header);
			if (!match)
				throw new Error(`LSP header without Content-Length: ${header}`);
			const bodyStart = headerEnd + HEADER_END.byteLength;
			const bodyEnd = bodyStart + Number(match[1]);
			if (buffer.byteLength < bodyEnd) return;
			const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			buffer = buffer.subarray(bodyEnd);
			onMessage(body);
		}
	};
}
