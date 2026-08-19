# tui-v2 渲染基线（v1 renderer，离线 baseline）

本目录收录旧渲染链路（React/Ink/Yoga）的冻结基线，供 v2 重写的离线对照与审阅。
这些文件只入库供审阅，不被 `src/` 引用，也不进入 `package.json` 的 `files` 发布面。

## 文件

- `baseline.json` — `v1-chat-startup` 与 `v1-stream-200` 两个 fixture 的正式采样
  （每 fixture 先 warm-up 100 个事件，正式样本 200 个，`formal: true`；p95 为样本排序
  nearest-rank；记录 GC 前后 heapUsed 与 RSS）。
- `clean-stop.json` — `v1-clean-stop` fixture：连续 3 次 spawn
  `test/tui-v2/helpers/lifecycle-child.tsx`，每次渲染真实 `Chat` 后干净退出，
  `results[0].details.exitCodes` 必须全为 0。
- `compare-skeleton.json` — WP-04 中间审阅报告（非 WP-09 `V1CaptureRenderer` 契约）：
  同一脚本化场景（welcome/user/流式 assistant/tool 卡）分别驱动 WP-01 harness
  （mock channel + 真实 Ink `Chat` + xterm oracle）与 v2 walking skeleton
  （fake channel → adapter → reducer → base-renderer → planner → writer →
  `VirtualTerminal`），记录两侧帧数、写入字节、峰值 heapUsed 与最终 grid hash。
  数值只作健全性对照，永不作为发布门槛。

## 基线运行环境

见各 JSON 的身份字段（缺一不能与历史基线比较）：

- Node：`v26.7.0`（本地基线机；CI gate 在 Node 22.19/24 上另跑 `test:tui-v2`/`verify:tui-v2`，
  bench 数值只在同 runner 间比较，跨硬件不比较绝对值）
- OS/内核：`linux x64`，详见 JSON 的 `kernel` 字段
- profile：`headless-fake-tty-120x40`（FakeStdout/FakeStdin + `@xterm/headless` oracle，
  不开真实 TTY；屏幕固定 120x40）
- commit / lockfileSha256：见 JSON 的 `gitHead` / `lockfileSha256`

## 再生命令

```bash
pnpm bench:tui-v2 -- --fixture v1-chat-startup,v1-stream-200 --seed 1 \
  --output docs/tui-v2/baseline/baseline.json
pnpm bench:tui-v2 -- --fixture v1-clean-stop --seed 1 \
  --output docs/tui-v2/baseline/clean-stop.json
node --expose-gc --import tsx/esm scripts/compare-tui-v2-skeleton.ts -- \
  --output docs/tui-v2/baseline/compare-skeleton.json
```

`bench:tui-v2` 固定为 `node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts`；
绕过 package script 直跑也必须显式带 `--expose-gc`（脚本入口对 `global.gc` fail-fast）。

## 无法测量的指标

测不出的指标在 JSON 中记为 `'unknown'`（例如 fixture 无法产生帧间隔序列时
`details.frameIntervals` 为 `'unknown'`），不以编造数值或主观结论替代。
