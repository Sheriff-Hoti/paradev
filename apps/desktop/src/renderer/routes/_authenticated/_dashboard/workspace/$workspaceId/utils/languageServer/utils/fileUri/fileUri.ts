import type { LspLanguage } from "../../constants";

const LANGUAGE_IDS: Record<
	string,
	{ language: LspLanguage; languageId: string }
> = {
	ts: { language: "typescript", languageId: "typescript" },
	mts: { language: "typescript", languageId: "typescript" },
	cts: { language: "typescript", languageId: "typescript" },
	tsx: { language: "typescript", languageId: "typescriptreact" },
	js: { language: "typescript", languageId: "javascript" },
	mjs: { language: "typescript", languageId: "javascript" },
	cjs: { language: "typescript", languageId: "javascript" },
	jsx: { language: "typescript", languageId: "javascriptreact" },
};

export function lspDocumentFor(
	filePath: string,
): { language: LspLanguage; languageId: string } | null {
	const extension = /\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase();
	return (extension && LANGUAGE_IDS[extension]) || null;
}

/** Percent-encodes each segment the way VS Code and tsserver do. */
export function pathToFileUri(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
	return `file://${withRoot
		.split("/")
		.map((segment, index) =>
			index === 1 && /^[a-zA-Z]:$/.test(segment)
				? segment
				: encodeURIComponent(segment),
		)
		.join("/")}`;
}

export function fileUriToPath(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	const path = decodeURIComponent(new URL(uri).pathname);
	return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path;
}

export function sameFileUri(a: string, b: string): boolean {
	return a === b || fileUriToPath(a) === fileUriToPath(b);
}
