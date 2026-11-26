import { describe, expect, test } from "bun:test";
import {
	fileUriToPath,
	lspDocumentFor,
	pathToFileUri,
	sameFileUri,
} from "./fileUri";

describe("fileUri", () => {
	test("encodes like the TypeScript server and round-trips", () => {
		const path = "/repo/routes/$workspaceId/a b.tsx";
		const uri = pathToFileUri(path);
		expect(uri).toBe("file:///repo/routes/%24workspaceId/a%20b.tsx");
		expect(fileUriToPath(uri)).toBe(path);
		expect(sameFileUri(uri, "file:///repo/routes/$workspaceId/a%20b.tsx")).toBe(
			true,
		);
		expect(fileUriToPath(pathToFileUri("C:\\repo\\a.ts"))).toBe("C:/repo/a.ts");
	});

	test("maps TS and JS files to the TypeScript server only", () => {
		expect(lspDocumentFor("a/b.tsx")).toEqual({
			language: "typescript",
			languageId: "typescriptreact",
		});
		expect(lspDocumentFor("a/b.mjs")?.languageId).toBe("javascript");
		expect(lspDocumentFor("a/b.py")).toBeNull();
		expect(lspDocumentFor("Makefile")).toBeNull();
	});
});
