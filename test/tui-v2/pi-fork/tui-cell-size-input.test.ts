/**
 * pi fork: ported from pi packages/tui/test/tui-cell-size-input.test.ts
 * (upstream 086c32e74530564922d011ade23ff582c9d63116, @earendil-works/pi-tui 0.84.2, MIT; WP-03a).
 *
 * Imports point at the vendored tree (src/tui-v2/vendor/pi-tui/src/..., .js
 * specifiers). Top-level describe/it names carry the `pi fork: ` prefix so the
 * WP-03 dependency check (--test-name-pattern 'pi fork|terminal|overlay') selects
 * this file.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { getCellDimensions, resetCapabilitiesCache, setCellDimensions } from "../../../src/tui-v2/vendor/pi-tui/src/terminal-image.js";
import type { Component, TUI } from "../../../src/tui-v2/vendor/pi-tui/src/tui.js";
import { TuiMainScreen } from "../../../src/tui-v2/vendor/pi-tui/src/tui-main-screen.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

function withImageTerminal<T>(fn: () => T): T {
	const prevTermProgram = process.env.TERM_PROGRAM;
	const prevTerm = process.env.TERM;
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.TERM;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = prevTermProgram;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		resetCapabilitiesCache();
	}
}

describe("pi fork: TUI cell size responses", () => {
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});
});
