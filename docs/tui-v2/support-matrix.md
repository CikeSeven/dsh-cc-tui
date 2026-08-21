# tui-v2 终端模式与图片支持矩阵（WP-07/WP-08e2）

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
| `supportsNestedOverlay` | ✅ | ❌ | inline 不合成 overlay：栈被剥离（`overlayStack=[]` 传给 compositor），每个新可见 business 或 utility overlay 经 dock 通知行发一次明确 warning（"Inline mode cannot render overlay dialogs; the dialog is hidden and keys still apply"）+ `overlay/unsupported` 诊断；栈空后重臂。approval/question/plugin、picker/help/history/transcript-search、session/workspace、settings/model/preset/effort 仍持有键盘焦点（按 focused overlayId 路由），这是可操作但不可见的明确降级，不是 overlay parity。 |
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

## 图片协议边界（WP-08e2）

- **fullscreen**：仅对 profile 明确确认的 Kitty APC 与 iTerm2 OSC 1337 输出受控协议字节；Kitty 上传先分块、再以 placement reference 放置，iTerm2 每个 placement 在目标 cursor 处执行一次 inline upload。`sixel`、`null`、`unknown` 或 profile/request 不匹配均不发送图片字节，改为占位符与 `unsupported-image` 诊断。
- **inline**：不发送 Kitty/iTerm2 图片字节，也不伪装 fullscreen parity；图片只走明确 placeholder/fallback，append-only cell path 保持不变。
- **进程内 store**：默认 32 MiB、最多 128 entries，单 entry 上限 5 MiB；内容以 SHA-256/hash-only metadata 寻址，bytes 不进入 Frame、AppEvent、trace、诊断或 JSON。LRU 只能淘汰没有 generation reference 或 explicit lease 的 entry；resize、generation 失效、delete/clear 和 stop 释放引用。
- **安全 seam**：`stageImage` 只返回 token/hash/mediaType/bytes/dimensions/name metadata；唯一 writer 在 upload 前再次校验 storeKey/hash/protocol，并拒绝 place-before-upload。Kitty canonical placement identity 从受控 `p=` 恢复，避免 byte-level oracle 静默忽略 image 差异。

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
3. **overlay 不可见但吃键**：inline 下 approval/question/plugin、picker/help/history/transcript-search、session/workspace 以及 settings/model/preset/effort 均不渲染；键盘仍由当前 focused overlayId 对应 controller 持有（Enter/Esc/筛选/编辑照常生效）。每个新 overlay 有 dock warning + 诊断；这是明确 warning 降级，不伪装 fullscreen overlay parity。

## WP-08f external action 支持边界

| 场景 | fullscreen | inline | 语义 |
| --- | --- | --- | --- |
| `!`/`!!` shell | 支持；child output 先 sanitize 后投影 | 支持；只能 append-only local rows/notice | 不污染 writer/frame；stdin/stdout/stderr owner 明确，timeout/SIGINT/cancel/late token 有界 |
| clipboard paste | text/files/image；image 复用 stageImage | 同一 input route；不承诺应用 selection parity | image bytes 只进 ImageStore；失败/unsupported notice |
| OSC52 copy | profile 明确支持时 writer trusted sequence | 同一 capability；不支持时明确失败 | WP-08g 负责 negotiation，本包不新增底层协商 |
| external editor | `ScreenTakeover` suspend → child → restore/full redraw | 同一安全 transfer；无法安全 transfer 则 unsupported | temp file 0600、timeout/cancel/nonzero/empty、raw/alt/mouse/paste/cursor 恢复 |
| update restart | 注入 runner + takeover/cleanup | 同一状态反馈，不伪装 alt-screen | controller 不调用 process.exit；late result 丢弃 |
| notifications/theme/i18n | dock/picker 正常布局 | 有界 dock/append 反馈；overlay 可不可见但不静默 | Clock timeout、dedupe/sticky；theme registry/language capability 安全 fallback |

上述 action 的 trace 只记录 `external-actions@v1` 的 bounded summary（kind/status/generation/count/hash），禁止 secrets、raw command/env、child output 原文和 clipboard/image bytes。详细 stdout/stderr owner 见 `docs/tui-v2-stdout-ownership.md`。

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
    "overlay invisible but keyboard-owning: business and utility overlays (including settings/model/preset/effort) are stripped from the inline frame, emit an explicit dock warning, and still consume keys via their focused controller"
  ]
}
```
