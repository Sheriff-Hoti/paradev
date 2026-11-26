import { type Diagnostic, setDiagnostics } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import type { Text } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type * as lsp from "vscode-languageserver-protocol";
import { DIAGNOSTICS_DEBOUNCE_MS } from "../../constants";

const SEVERITIES: Record<number, Diagnostic["severity"]> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
};

/** Servers that only answer `textDocument/diagnostic` (TypeScript 7) never push diagnostics. */
export const pullDiagnostics = ViewPlugin.fromClass(
	class {
		private timer: ReturnType<typeof setTimeout> | undefined;
		private generation = 0;
		private destroyed = false;

		constructor(private readonly view: EditorView) {
			this.schedule(0);
		}

		update(update: ViewUpdate) {
			if (update.docChanged || (update.focusChanged && update.view.hasFocus)) {
				this.schedule(DIAGNOSTICS_DEBOUNCE_MS);
			}
		}

		destroy() {
			this.destroyed = true;
			clearTimeout(this.timer);
		}

		private schedule(delay: number) {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => void this.pull(), delay);
		}

		private async pull() {
			const plugin = LSPPlugin.get(this.view);
			if (!plugin?.client.connected) return;
			const generation = ++this.generation;
			const doc = this.view.state.doc;
			let report: lsp.DocumentDiagnosticReport;
			try {
				plugin.client.sync();
				report = await plugin.client.request<
					lsp.DocumentDiagnosticParams,
					lsp.DocumentDiagnosticReport
				>("textDocument/diagnostic", { textDocument: { uri: plugin.uri } });
			} catch {
				return;
			}
			if (
				this.destroyed ||
				generation !== this.generation ||
				this.view.state.doc !== doc ||
				report.kind !== "full"
			) {
				return;
			}
			const diagnostics = report.items.flatMap((item) =>
				toDiagnostic(plugin, item, doc),
			);
			this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
		}
	},
);

function toDiagnostic(
	plugin: LSPPlugin,
	item: lsp.Diagnostic,
	doc: Text,
): Diagnostic[] {
	try {
		const from = plugin.fromPosition(item.range.start, doc);
		const to = plugin.fromPosition(item.range.end, doc);
		return [
			{
				from,
				to: Math.max(from, to),
				severity: SEVERITIES[item.severity ?? 1] ?? "error",
				message:
					typeof item.message === "string" ? item.message : item.message.value,
				source: item.source,
			},
		];
	} catch {
		return [];
	}
}
