# tui-v2 终端模式支持矩阵（WP-07）

本文是 fullscreen（alt-screen）与 inline（main-screen）两种后端的**能力对账表**。文末的
`json` 机器块由 `pnpm verify:tui-v2 -- --check inline` 解析，逐字段与
`src/tui-v2/terminal/fullscreen-backend.ts` 的 `FULLSCREEN_CAPABILITIES`、
`src/tui-v2/terminal/inline-backend.ts` 的 `INLINE_CAPABILITIES` 对账：
值不一致、或两模式取值不同却没有非空 note，都会让 check 失败。
fullscreen 专属能力必须显式登记差异，不允许静默伪装 parity（§WP-07 依赖检查）。

## 能力矩阵

| 能力 | fullscreen | inline | 说明 |
| --- | --- | --- | --- |
| `supportsViewportLayout` | ✅ | ❌ | inline 永远整视口直排：frame = screen，物理屏逐行镜像帧；没有独立 viewport 布局层。 |
| `supportsNestedOverlay` | ✅ | ❌ | inline 不合成 overlay：栈被剥离（`overlayStack=[]` 传给 compositor），每个新可见 business 或 utility overlay 经 dock 通知行发一次明确 warning（"Inline mode cannot render overlay dialogs; the dialog is hidden and keys still apply"）+ `overlay/unsupported` 诊断；栈空后重臂。approval/question/plugin、picker/help/history/transcript-search 仍持有键盘焦点（按 focused overlayId 路由），这是可操作但不可见的明确降级，不是 overlay parity。 |
| `supportsScrollRegion` | ✅ | ❌ | inline 从不发 DECSTBM，也不发 `scroll` op；滚屏只有 bottom-row LF 一种原语（`line-feed` patch op），且只在全高主屏区域上滚时把**已 settled** 的顶部行推进 scrollback。 |
| `supportsInlineLiveRegion` | ❌ | ✅ | inline 专属：帧 metadata 携带 `inline: { liveStart, followEnd }` hint——`[0..liveStart)` 是 settled 前缀（只允许进 scrollback，绝不原地改），`[liveStart..height)` 是 live region（streaming 行 / unseen indicator / 整个 dock，原地重绘）。fullscreen 不使用该 hint。 |

## scrollback 语义差异

- fullscreen：scrollback 归终端仿真器所有（alt-screen 期间不可达），后端从不写 scrollback。
- inline：scrollback 只收 **settled** 行。append 配方在 follow-end 增长时做最小滚动
  （`k` 升序搜索第一个无缝前缀，`k === ps` 永不选取——全滚不如重锚；
  只含空白 pad 行的滚动被拒绝，宁缺勿滥）。非 follow-end 帧（用户在翻阅）
  与回到 follow-end 的第一帧一律原地重绘，不喂 scrollback，杜绝 pageUp→pageDown
  重复入行。危险序列禁令：inline patch 字节里永不出现 ED 3（`CSI 3 J` 清 scrollback）
  与 DECSTBM。

## 第三方输出（main-screen 共享）

inline 会话与终端上的外来写入者共享主屏（插件 `console.log`、子进程输出）。
coordinator 用 `ForeignOutputGuard`（`src/tui-v2/terminal/foreign-output.ts`）monkey-patch
底层 stream 的 `write`：经 writer 代理写入的字节不计数，绕过 writer 的直接写入记为
foreign → `output/foreign` 诊断 + 下一帧 `damage` 全量重锚（erase + 绝对重写，
**不**喂 scrollback、不发 ED 2/3）。guard 在 stop 时 detach，恢复原 `write`。

## 安全退出 park

inline 退出前由 backend 产出一个 park patch（`line-feed` 一行 + 光标停在帧下方
`(0, rows-1)` 可见），让 shell prompt 落在帧之下而不是覆盖 dock。writer 的 cleanup
bundle 里 `resetScrollRegion()`（`CSI r`）按 xterm 语义会把光标 home 到 (0,0)，
因此 lifecycle 对 inline（以及任何 `preserveScreen` 停止）传
`preserveCursor: true` 跳过该 reset（WP-07 契约变更，见 §15.1 WP-07 条目）。

## 已知差距（显式登记，不伪装 parity）

1. **tall-stream gap**：单个 streaming 行比 transcript 视口还高时（liveStart 被钉到 0），
   该行中段在其存续期间不进入 scrollback；settle 后才逐行归档。宁缺勿滥——
   不滚优于滚错（重复/拷贝）。
2. **单帧爆增 gap**：一帧内增长超过视口高度时，超出部分直接重锚，中间行不进
   scrollback。
3. **overlay 不可见但吃键**：inline 下 approval/question/plugin 以及 picker/help/history/transcript-search 均不渲染；键盘仍由当前 focused overlayId 对应 controller 持有（Enter/Esc/筛选照常生效）。每个新 overlay 有 dock warning + 诊断；这是明确 warning 降级，不伪装 fullscreen overlay parity。

## 机器块（verify --check inline Part 4 对账用）

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "supportsViewportLayout": {
      "fullscreen": true,
      "inline": false,
      "note": "inline is always frame = screen: full-viewport column layout, no separate viewport layout layer."
    },
    "supportsNestedOverlay": {
      "fullscreen": true,
      "inline": false,
      "note": "inline strips the overlay stack; each newly visible overlay raises one dock warning + overlay/unsupported diagnostic; the hidden dialog keeps the keyboard."
    },
    "supportsScrollRegion": {
      "fullscreen": true,
      "inline": false,
      "note": "inline never emits DECSTBM or scroll ops; bottom-row line-feed on the full-height main-screen region is the only scroll primitive."
    },
    "supportsInlineLiveRegion": {
      "fullscreen": false,
      "inline": true,
      "note": "inline-only frame hint (liveStart + followEnd): settled prefix may leave only into scrollback; the live region repaints in place."
    }
  },
  "knownGaps": [
    "tall-stream gap: a streaming row taller than the transcript viewport pins liveStart to 0; its middle section reaches scrollback only after settling",
    "single-frame burst gap: growth beyond the viewport in one frame re-anchors without archiving the skipped middle lines",
    "overlay invisible but keyboard-owning: business and utility overlays are stripped from the inline frame, emit an explicit dock warning, and still consume keys via their focused controller"
  ]
}
```
