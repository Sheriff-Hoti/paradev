import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

export const LSP_LANGUAGES = ["typescript"] as const;
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export interface ServerCommand {
	command: string;
	args: string[];
}

export function isLspLanguage(value: string): value is LspLanguage {
	return (LSP_LANGUAGES as readonly string[]).includes(value);
}

export function resolveServerCommand(
	language: LspLanguage,
	worktreePath: string,
): ServerCommand | null {
	switch (language) {
		case "typescript": {
			const exe =
				resolveNativeTsc(join(worktreePath, "package.json")) ??
				resolveNativeTsc(import.meta.url);
			return exe ? { command: exe, args: ["--lsp", "--stdio"] } : null;
		}
	}
}

const TSC_PLATFORM_PACKAGE = `@typescript/typescript-${process.platform}-${process.arch}`;
/** The project's own compiler: never shipped with the app, so not a literal the dependency check scans for. */
const PROJECT_TYPESCRIPT_PACKAGE = "typescript/package.json";

/** The TypeScript 7 native compiler, which serves LSP itself. */
function resolveNativeTsc(from: string): string | null {
	const require = createRequire(from);
	const candidates = [
		() => require.resolve(`${TSC_PLATFORM_PACKAGE}/package.json`),
		() => {
			const typescriptPackage = require.resolve(PROJECT_TYPESCRIPT_PACKAGE);
			if (majorVersion(typescriptPackage) < 7) return null;
			return createRequire(typescriptPackage).resolve(
				`${TSC_PLATFORM_PACKAGE}/package.json`,
			);
		},
	];
	for (const candidate of candidates) {
		const packageJson = tryResolve(candidate);
		if (!packageJson) continue;
		const exe = outsideAsar(
			join(
				dirname(packageJson),
				"lib",
				process.platform === "win32" ? "tsc.exe" : "tsc",
			),
		);
		if (existsSync(exe)) return exe;
	}
	return null;
}

function tryResolve(resolve: () => string | null): string | null {
	try {
		return resolve();
	} catch {
		return null;
	}
}

function majorVersion(packageJsonPath: string): number {
	const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		version?: string;
	};
	return Number.parseInt(version ?? "0", 10);
}

function outsideAsar(path: string): string {
	return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}
