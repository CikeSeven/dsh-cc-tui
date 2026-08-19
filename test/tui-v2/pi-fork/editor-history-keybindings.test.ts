/**
 * pi fork: ported from pi packages/tui/test/editor-history-keybindings.test.ts
 * (upstream 086c32e74530564922d011ade23ff582c9d63116, @earendil-works/pi-tui 0.84.2, MIT; WP-03a).
 *
 * Imports point at the vendored tree (src/tui-v2/vendor/pi-tui/src/..., .js
 * specifiers). Top-level describe/it names carry the `pi fork: ` prefix so the
 * WP-03 dependency check (--test-name-pattern 'pi fork|terminal|overlay') selects
 * this file.
 */
import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../../../src/tui-v2/vendor/pi-tui/src/components/editor.js";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../../../src/tui-v2/vendor/pi-tui/src/keybindings.js";
import { TuiMainScreen } from "../../../src/tui-v2/vendor/pi-tui/src/tui-main-screen.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("pi fork: Editor prompt history keybindings", () => {
	it("browses history directly without first moving the cursor", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.addToHistory("newer\nmultiline prompt");
		editor.setText("draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		editor.handleInput("\x10"); // Ctrl+P
		assert.strictEqual(editor.getText(), "older prompt");

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x0e"); // Ctrl+N
		assert.strictEqual(editor.getText(), "draft");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
	});
});
