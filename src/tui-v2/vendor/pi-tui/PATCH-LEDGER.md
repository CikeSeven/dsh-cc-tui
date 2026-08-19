# pi-tui fork patch ledger (WP-03)

Every non-mechanical local difference from the pinned upstream snapshot
(`086c32e74530564922d011ade23ff582c9d63116`, `@earendil-works/pi-tui` 0.84.2) must be a row
in the table below. Mechanical transformations performed by
`scripts/vendor-pi-tui.mjs` are recorded as row(s) with kind = mechanical.
Re-vendor steps column names the exact command that reapplies the fork state.

| 文件 | 上游行为 | DSH 改动 | 原因 | 回归测试 | re-vendor 步骤 |
| --- | --- | --- | --- | --- | --- |
| mechanical: `src/tui-v2/vendor/pi-tui/src/**/*.ts` | 上游相对路径 import/export specifier 带 `.ts` 后缀（strip-types 风格） | 机械改写为 `.js` 后缀（bundler resolution；内容由 `scripts/vendor-pi-tui.mjs` 在复制时转换） | 本仓库 tsconfig 用 bundler resolution + `tsc` 输出，运行 import 必须 `.js`；不计行为 patch | `pnpm compile` + `node scripts/test-tui-v2.mjs`（`test/tui-v2/pi-fork/` 全部上游移植测试） | `node scripts/vendor-pi-tui.mjs --source <pi checkout>`（重写自动应用，无需手工步骤） |
