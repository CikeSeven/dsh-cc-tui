/**
 * pi fork: ported from pi packages/tui/test/regression-overlay-cjk-boundary.test.ts
 * (upstream 086c32e74530564922d011ade23ff582c9d63116, @earendil-works/pi-tui 0.84.2, MIT; WP-03a).
 *
 * Imports point at the vendored tree (src/tui-v2/vendor/pi-tui/src/..., .js
 * specifiers). Top-level describe/it names carry the `pi fork: ` prefix so the
 * WP-03 dependency check (--test-name-pattern 'pi fork|terminal|overlay') selects
 * this file.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { compositeTuiLine } from "../../../src/tui-v2/vendor/pi-tui/src/tui.js";
import { extractSegments, sliceByColumn, visibleWidth } from "../../../src/tui-v2/vendor/pi-tui/src/utils.js";

describe("pi fork: overlay CJK boundary regression", () => {
	it("excludes a wide grapheme from before when overlay starts inside it", () => {
		const segments = extractSegments("abcd让EFGH", 5, 9, 11, true);

		assert.strictEqual(segments.before, "abcd");
		assert.strictEqual(segments.beforeWidth, 4);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
		assert.strictEqual(segments.after, "H");
		assert.strictEqual(segments.afterWidth, 1);
	});

	it("keeps ASCII before-segment behavior at the same boundary", () => {
		const segments = extractSegments("abcdG EFGH", 5, 9, 11, true);

		assert.strictEqual(segments.before, "abcdG");
		assert.strictEqual(segments.beforeWidth, 5);
		assert.strictEqual(visibleWidth(segments.before), segments.beforeWidth);
	});

	it("composites an overlay at the requested column when it starts inside a wide grapheme", () => {
		const out = compositeTuiLine("abcd让EFGH", "│XX│", 5, 4, 20);
		const prefix = sliceByColumn(out, 0, 5, true);
		const overlay = sliceByColumn(out, 5, 4, true);

		assert.strictEqual(out.includes("让"), false);
		assert.strictEqual(visibleWidth(out), 20);
		assert.strictEqual(visibleWidth(prefix), 5);
		assert.strictEqual(visibleWidth(overlay), 4);
		assert.strictEqual(overlay.includes("│XX│"), true);
	});

	it("composites an overlay when it starts at a wide grapheme boundary", () => {
		const out = compositeTuiLine("abcd让EFGH", "│XX│", 4, 4, 20);
		const overlay = sliceByColumn(out, 4, 4, true);

		assert.strictEqual(out.includes("让"), false);
		assert.strictEqual(visibleWidth(out), 20);
		assert.strictEqual(visibleWidth(overlay), 4);
		assert.strictEqual(overlay.includes("│XX│"), true);
	});
});
