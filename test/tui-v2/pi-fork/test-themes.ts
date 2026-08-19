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

import { Chalk } from "chalk";
import type { EditorTheme } from "../../../src/tui-v2/vendor/pi-tui/src/components/editor.js";
import type { SelectListTheme } from "../../../src/tui-v2/vendor/pi-tui/src/components/select-list.js";

const chalk = new Chalk({ level: 3 });

export const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: (text: string) => chalk.blue(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: (text: string) => chalk.dim(text),
	selectList: defaultSelectListTheme,
};
