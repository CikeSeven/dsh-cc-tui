# tui-v2 历史渲染基线（只读审阅材料）

本目录保留 WP-01/WP-04 生成的历史报告，供迁移审阅。它们不是生产 fallback，也不是
live test helper；可执行的离线 baseline 边界只有 `tools/tui-v2-baseline/`，不会被 `src/`
或 package 发布面引用。

## 文件

- `baseline.json` — 历史 `v1-chat-startup` 与 `v1-stream-200` 采样；保留原始身份字段，
  不因 v2 benchmark 入口迁移而重写。
- `clean-stop.json` — 历史 `v1-clean-stop` 报告；其中的旧 child/harness source 已退役，
  但冻结 JSON 仍作为审阅材料保留。manifest/source hash 与 artifact/license 由
  `test/tui-v2/baseline-compare.test.ts` 和 `verify:tui-v2` 独立校验；source 文件缺失只
  记录为 `missingSourceFiles`，不会重建旧 source。

## 当前 v2 benchmark

`bench:tui-v2` 已迁移到 `createTuiV2App`/coordinator、v2 frame pipeline 和
`VirtualTerminal`。它的默认输出写入临时目录，不覆盖本目录的历史 JSON：

```bash
pnpm bench:tui-v2 -- --fixture v2-coordinator-startup,v2-stream-200,v2-clean-stop \
  --iterations 200 --seed 1 --output "$RUNNER_TEMP/tui-v2/bench.json"
```

固定入口为 `node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts`；绕过 package
script 直跑也必须显式带 `--expose-gc`，入口会对 `global.gc` fail-fast。每个 v2 fixture
都使用 120x40 的注入 stream + `VirtualTerminal`，不会打开真实 TTY 或写入 process stdout
作为终端。

## 历史环境

历史 JSON 的 Node、OS、kernel、profile、commit 和 `lockfileSha256` 只用于解释它们的
生成环境；bench 数值只在相同 runner 间比较，不能跨硬件比较绝对值。

无法测量的指标在 JSON 中记为 `'unknown'`，不以编造数值或主观结论替代。
