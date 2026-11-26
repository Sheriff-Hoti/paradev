import { jumpToDefinition } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
} from "@codemirror/view";

const isMac = /Mac/.test(navigator.platform);

function hasDefinitionModifier(event: MouseEvent | KeyboardEvent): boolean {
	return isMac ? event.metaKey : event.ctrlKey;
}

const linkMark = Decoration.mark({ class: "cm-definition-link" });

const definitionLinkUnderline = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet = Decoration.none;
		private pointer: { x: number; y: number } | null = null;
		private modifierHeld = false;

		constructor(private readonly view: EditorView) {
			window.addEventListener("keydown", this.onKey);
			window.addEventListener("keyup", this.onKey);
			window.addEventListener("blur", this.onBlur);
		}

		destroy() {
			window.removeEventListener("keydown", this.onKey);
			window.removeEventListener("keyup", this.onKey);
			window.removeEventListener("blur", this.onBlur);
		}

		trackPointer(event: MouseEvent) {
			this.pointer = { x: event.clientX, y: event.clientY };
			this.modifierHeld = hasDefinitionModifier(event);
			this.refresh();
		}

		clearPointer() {
			this.pointer = null;
			this.refresh();
		}

		private onKey = (event: KeyboardEvent) => {
			const held = hasDefinitionModifier(event);
			if (held === this.modifierHeld) return;
			this.modifierHeld = held;
			this.refresh();
		};

		private onBlur = () => {
			this.modifierHeld = false;
			this.refresh();
		};

		private refresh() {
			const word =
				this.modifierHeld && this.pointer
					? wordAtCoords(this.view, this.pointer)
					: null;
			const next = word
				? Decoration.set(linkMark.range(word.from, word.to))
				: Decoration.none;
			if (next.size === 0 && this.decorations.size === 0) return;
			this.decorations = next;
			this.view.dispatch({});
		}
	},
	{
		decorations: (plugin) => plugin.decorations,
		eventHandlers: {
			mousemove(event) {
				this.trackPointer(event);
			},
			mouseleave() {
				this.clearPointer();
			},
		},
	},
);

function wordAtCoords(view: EditorView, coords: { x: number; y: number }) {
	const pos = view.posAtCoords(coords, false);
	return view.state.wordAt(pos);
}

/** Ctrl/Cmd+click jumps to the definition; Alt+click adds a cursor instead. */
export const definitionClick: Extension = [
	EditorView.clickAddsSelectionRange.of((event) => event.altKey),
	EditorView.domEventHandlers({
		mousedown(event, view) {
			if (event.button !== 0 || !hasDefinitionModifier(event)) return false;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) return false;
			event.preventDefault();
			view.dispatch({ selection: { anchor: pos } });
			jumpToDefinition(view);
			return true;
		},
	}),
	definitionLinkUnderline,
	EditorView.baseTheme({
		".cm-definition-link": {
			textDecoration: "underline",
			cursor: "pointer",
		},
	}),
];
