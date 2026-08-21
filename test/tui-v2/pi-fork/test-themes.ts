/**
 * pi fork: ported from pi packages/tui/test/test-themes.ts
 * (upstream 086c32e74530564922d011ade23ff582c9d63116, @earendil-works/pi-tui
 * 0.84.2, MIT; WP-03a).
 *
 * Local adaptations:
 *   - imports rewritten from the excluded index.ts barrel to concrete vendored
 *     modules;
 *   - defaultMarkdownTheme dropped (Markdown component is excluded in WP-03a).
 */

import type { EditorTheme } from "../../../src/tui-v2/vendor/pi-tui/src/components/editor.js";
import type { SelectListTheme } from "../../../src/tui-v2/vendor/pi-tui/src/components/select-list.js";

const sgr = (open: number, close: number) => (text: string): string => `\x1b[${open}m${text}\x1b[${close}m`;
const blue = sgr(34, 39);
const bold = sgr(1, 22);
const dim = sgr(2, 22);

export const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: blue,
	selectedText: bold,
	description: dim,
	scrollInfo: dim,
	noMatch: dim,
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: dim,
	selectList: defaultSelectListTheme,
};
