/**
 * pi fork: ported from pi packages/tui/test/regression-regional-indicator-width.test.ts
 * (upstream 086c32e74530564922d011ade23ff582c9d63116, @earendil-works/pi-tui 0.84.2, MIT; WP-03a).
 *
 * Imports point at the vendored tree (src/tui-v2/vendor/pi-tui/src/..., .js
 * specifiers). Top-level describe/it names carry the `pi fork: ` prefix so the
 * WP-03 dependency check (--test-name-pattern 'pi fork|terminal|overlay') selects
 * this file.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "../../../src/tui-v2/vendor/pi-tui/src/utils.js";

describe("pi fork: regional indicator width regression", () => {
	it("treats partial flag grapheme as full-width to avoid streaming render drift", () => {
		// Repro context:
		// During streaming, "🇨🇳" often appears as an intermediate "🇨" first.
		// If "🇨" is measured as width 1 while terminal renders it as width 2,
		// differential rendering can drift and leave stale characters on screen.
		const partialFlag = "🇨";
		const listLine = "      - 🇨";

		assert.strictEqual(visibleWidth(partialFlag), 2);
		assert.strictEqual(visibleWidth(listLine), 10);
	});

	it("wraps intermediate partial-flag list line before overflow", () => {
		// Width 9 cannot fit "      - 🇨" if 🇨 is width 2 (8 + 2 = 10).
		// This must wrap to avoid terminal auto-wrap mismatch.
		const wrapped = wrapTextWithAnsi("      - 🇨", 9);

		assert.strictEqual(wrapped.length, 2);
		assert.strictEqual(visibleWidth(wrapped[0] || ""), 7);
		assert.strictEqual(visibleWidth(wrapped[1] || ""), 2);
	});

	it("treats all regional-indicator singleton graphemes as width 2", () => {
		for (let cp = 0x1f1e6; cp <= 0x1f1ff; cp++) {
			const regionalIndicator = String.fromCodePoint(cp);
			assert.strictEqual(
				visibleWidth(regionalIndicator),
				2,
				`Expected ${regionalIndicator} (U+${cp.toString(16).toUpperCase()}) to be width 2`,
			);
		}
	});

	it("keeps full flag pairs at width 2", () => {
		const samples = ["🇯🇵", "🇺🇸", "🇬🇧", "🇨🇳", "🇩🇪", "🇫🇷"];
		for (const flag of samples) {
			assert.strictEqual(visibleWidth(flag), 2, `Expected ${flag} to be width 2`);
		}
	});

	it("keeps common streaming emoji intermediates at stable width", () => {
		const samples = ["👍", "👍🏻", "✅", "⚡", "⚡️", "👨", "👨‍💻", "🏳️‍🌈"];
		for (const sample of samples) {
			assert.strictEqual(visibleWidth(sample), 2, `Expected ${sample} to be width 2`);
		}
	});
});
