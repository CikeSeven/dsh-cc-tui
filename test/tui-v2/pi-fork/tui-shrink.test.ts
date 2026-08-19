/**
 * pi fork: ported from pi packages/tui/test/tui-shrink.test.ts
 * (upstream 086c32e74530564922d011ade23ff582c9d63116, @earendil-works/pi-tui 0.84.2, MIT; WP-03a).
 *
 * Imports point at the vendored tree (src/tui-v2/vendor/pi-tui/src/..., .js
 * specifiers). Top-level describe/it names carry the `pi fork: ` prefix so the
 * WP-03 dependency check (--test-name-pattern 'pi fork|terminal|overlay') selects
 * this file.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../../../src/tui-v2/vendor/pi-tui/src/tui.js";
import { TuiMainScreen } from "../../../src/tui-v2/vendor/pi-tui/src/tui-main-screen.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class Lines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

describe("pi fork: TUI shrinking content", () => {
	it("clears all rendered lines when content shrinks to zero", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const content = new Lines(["first", "second", "third"]);
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("first")));
		assert.ok(terminal.getViewport().some((line) => line.includes("second")));
		assert.ok(terminal.getViewport().some((line) => line.includes("third")));

		tui.clear();
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("first")), "first line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("second")), "second line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("third")), "third line should be cleared");

		tui.stop();
	});
});
