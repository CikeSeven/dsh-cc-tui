/**
 * pi fork: ported from pi packages/tui/test/overlay-short-content.test.ts
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

class SimpleContent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

class SimpleOverlay implements Component {
	render(): string[] {
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	invalidate() {}
}

describe("pi fork: TUI overlay with short content", () => {
	it("should render overlay when content is shorter than terminal height", async () => {
		// Terminal has 24 rows, but content only has 3 lines
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);

		// Only 3 lines of content
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		// Show overlay centered - should be around row 10 in a 24-row terminal
		const overlay = new SimpleOverlay();
		tui.showOverlay(overlay);

		// Trigger render
		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const hasOverlay = viewport.some((line) => line.includes("OVERLAY"));

		console.log("Terminal rows:", terminal.rows);
		console.log("Content lines: 3");
		console.log("Overlay visible:", hasOverlay);

		if (!hasOverlay) {
			console.log("\nViewport contents:");
			for (let i = 0; i < viewport.length; i++) {
				console.log(`  [${i}]: "${viewport[i]}"`);
			}
		}

		assert.ok(hasOverlay, "Overlay should be visible when content is shorter than terminal");

		tui.stop();
	});
});
