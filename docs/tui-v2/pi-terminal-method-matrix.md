# PiTerminalAdapter method matrix (WP-03c, plan §5.6)

逐项 matrix：`PiTerminalAdapter`（`src/tui-v2/terminal/pi-adapter.ts`）对 pinned pi
`Terminal` 接口（`src/tui-v2/vendor/pi-tui/src/terminal.ts`）的逐项满足情况。
所有同步方法只把 typed operation 入队到 `TerminalWriter` 的串行队列——同步返回
只代表"已入队"，字节落盘、backpressure、generation 校验、错误转换都是
writer/lifecycle 的职责；异步失败经 `onError`（adapter）与 lifecycle diagnostics
回传，调用方不得把同步返回当作已完成。

约定列含义：

- **pi 语义**：上游 `ProcessTerminal` 的行为（参考实现，dsh 运行时不使用）。
- **adapter 映射**：入队的 typed operation（lifecycle op 或 ansi.ts branded sequence，
  purpose 标注）。
- **backpressure/error**：writer 返回值的观察方式。
- **fixture**：覆盖该方法的测试位置。

## 方法逐项

| 方法 | pi 语义（ProcessTerminal） | adapter 映射 | backpressure/error 语义 | fixture |
| --- | --- | --- | --- | --- |
| `start(onInput, onResize)` | 同步接管：raw mode、异步 kitty 协商、监听 stdin data/resize | 存回调；kick `lifecycle.start(startOptions)`（幂等共享 promise）。输入事件由 input source → `dispatchInputEvent` 翻译回 pi wire 字符串：key→`payload.raw`；paste→`\x1b[200~…\x1b[201~`；mouse→重建 SGR 1006；focus→`\x1b[I`/`\x1b[O`；resize→`onResize()`；signal/query-response 不转发 |  takeover 失败在 `whenStarted()` 的 `LifecycleStartResult.error` 中（`start-state`/`unsupported-alternate-screen`/`failed-after-takeover`），不向 sync 调用抛出 | `terminal-pi-adapter.test.ts`（start/stop/输入分发）；`pi-fork-integration.test.ts`（Editor 回显、resize 重绘） |
| `stop()` | 同步恢复：清 kitty/进程 listener、raw off；**同步返回不代表清理完成** | kick `lifecycle.stop('user-exit')`（幂等共享 promise）；§5.7 barrier：input.stop → 反向 cleanup 序列 → writer.flush → writer.stop(cleanup bundle) → termios 恢复 → stdin drainInput → signal listener 移除 | 清理超期/失败进 lifecycle diagnostics（`cleanup-deadline`/`cleanup-op-timeout`/`stopped`）；writer 终态经 `failed-after-takeover` 上表面 | 两个测试文件的 stop/awaitStop 用例 |
| `awaitStop()` | pi 无此方法（dsh 扩展） | 返回 `stop()` kick 的 barrier promise；未 stop 时先补 kick | 见 `stop()` | 同上；集成测试断言 awaitStop 后 VT modes 全默认 + stdin listener 移除 |
| `drainInput(maxMs?, idleMs?)` | 排空 stdin（防 kitty release 泄到父 shell） | 直接委托 `input.drainInput(maxMs, idleMs)`（所有 timer 在注入 Clock 上） | 超时/idle 语义由 input source 保证；不抛错 | `terminal-pi-adapter.test.ts` drain 委托用例 |
| `write(data)` | 原样 `process.stdout.write(data)` | **严格 parser 边界**：缓冲上一次 partial 尾巴 → `parsePiTerminalString` → data run（text/SGR/OSC 8/换行）经 `ansi.piCellDataRun` 再校验 → sequence lane（`pi-compatible`）；control op 映射见下表。未知序列/payload 超 8 MiB → `unsupported-pi-sequence`，**该次 write 零字节下发** | 每个入队 op 的 `WriteResult`：`error`→`onError`；`stale`/`stopped`→计数（diagnostics()）；partial 尾巴缓冲上限 8 MiB，超限报错清零 | `terminal-pi-adapter.test.ts`：round-trip / 拒绝 / partial 重组 / 8 MiB cap / kitty·iTerm2·OSC52 图像与剪贴板 fixture |
| `columns` / `rows` | `process.stdout.columns/rows` 兜底 env | `stdout.columns ?? profile.columns`（与 lifecycle SIGWINCH 同源） | 纯读，无 I/O | adapter 测试（fake stdout 80×24） |
| `kittyProtocolActive` | ProcessTerminal 内部协商状态 | `lifecycle.currentModeSnapshot().kittyKeyboard`（以实际下发的 mode 为准） | 纯读 | adapter 测试（start 后 true / 未 start false） |
| `moveBy(lines)` | 正下移 `CSI n B`、负上移 `CSI n A`、0 不动 | lifecycle `cursor-move` op（delta 正=下负=上）；0 不入队 | 同 write 的 op 观察 | adapter 测试；集成测试间接覆盖（main-screen 渲染用 CUU/CUD） |
| `hideCursor()` / `showCursor()` | `CSI ? 25 l/h` | lifecycle `cursor` op（enabled=false/true） | 同上 | adapter 测试 |
| `clearLine()` | `CSI K`（EL 0） | lifecycle `clear` scope `line` → **EL 2**（`\x1b[2K`） | 同上 | adapter 测试；偏差见下 |
| `clearFromCursor()` | `CSI J`（ED 0） | lifecycle `clear` scope `from-cursor` → ED 0（字节相同） | 同上 | adapter 测试 |
| `clearScreen()` | `CSI 2J CSI H`（清屏+回家） | lifecycle `clear` scope `screen`（ED 2）+ sequence lane `ansi.cursorTo(1,1)`（`\x1b[1;1H`） | 同上 | adapter 测试；字节规范化偏差见下 |
| `setTitle(title)` | OSC 0（title+icon）BEL | lifecycle `title` op → `ansi.setTitle` 默认 scope **2**（仅 window title）；控制字符剥除、长度上限沿用 ansi builder | 同上；非法 title（非 string）同步抛 TypeError | adapter 测试；偏差见下 |
| `setProgress(active)` | true→OSC 9;4;3（indeterminate）+ keepalive interval；false→OSC 9;4;0 | true→lifecycle `progress` state **`normal`**（OSC 9;4;1，无 value）；false→`none`（OSC 9;4;0，字节相同）；无 keepalive | 同上 | adapter 测试；偏差见下 |

## `write(string)` 的 control-op 映射（parser op → typed operation）

| parser op | 映射 |
| --- | --- |
| text / newline / CR / LF / SGR / OSC 8 | 累积成 data run → `ansi.piCellDataRun` → sequence lane `pi-compatible` |
| cursor-up/down | lifecycle `cursor-move`（delta ∓count） |
| cursor-forward/back、cursor-column（CHA）、cursor-to（CUP） | sequence lane `ansi.cursorForward/Back/Column/To` |
| erase-line mode 2 | lifecycle `clear` `line`；mode 0/1 → sequence `ansi.eraseInLine` |
| erase-display mode 0 / 2 | lifecycle `clear` `from-cursor` / `screen`；mode 1/3 → sequence `ansi.eraseInDisplay` |
| mode 25 / 1049 / 2026 | lifecycle `cursor` / `enter-alt` / `sync-output` |
| 其他 allowlisted DEC mode（7, 47, 1000, 1002, 1003, 1004, 1006, 1015, 1047, 2004, 2031） | sequence lane `ansi.decset/decrst` |
| query cell-size / background-color / color-scheme | sequence lane `ansi.queryCellSize/queryBackgroundColor/queryColorScheme`，purpose `query-write`；**响应不接 broker**（input 层 query grammar 检测后无 token 认领即丢弃，已知边界） |
| title | lifecycle `title`（scope 2，见偏差） |
| progress state 0/1/2/4 | lifecycle `progress` none/normal/error/paused（value 0–100） |
| progress state 3（indeterminate） | sequence lane `ansi.progress('indeterminate')`（pinned lifecycle op 无此状态） |
| clipboard（OSC 52） | sequence lane `ansi.osc52Clipboard` |
| image kitty（APC `_G`） | sequence lane `ansi.kittyImage(keys, payload)`；空 payload 仅 a=d/a=p |
| image iterm2（OSC 1337） | sequence lane `ansi.iterm2Image`；`size` 取 payload 解码字节数，width/height 原样透传（N/Npx/N%/auto） |

## ScreenBackend 接线（`terminal/main-screen.ts` / `terminal/alt-screen.ts`）

- `PiTuiMainScreenBackend`（`mode: 'inline'`）：capabilities 全 false 唯
  `supportsInlineLiveRegion: true`；包装 vendored `TuiMainScreen`。
- `PiTuiAltScreenBackend`（`mode: 'fullscreen'`）：`supportsViewportLayout /
  supportsNestedOverlay / supportsScrollRegion: true`；包装 vendored
  `TuiAltScreen`（enter/exit alt、viewport、overlay、mouse/selection、
  主屏恢复全部走 fork 后的 piOutput builder 调用点）。
- 两 backend 共享同一 `PiTerminalStack`（writer+lifecycle+input+adapter）：
  alt 进入是同一会话上的 generation bump；`start(generation)` 校验非负整数且
  不回退（回退抛 RangeError），新一代 `lifecycle.setGeneration` 下传；首次
  start 跑 `tui.start()` 并 await `adapter.whenStarted()`。
- `plan(previous, next)`：同步保守规划（`screen-plan.ts`）。`previous null`/
  尺寸变化/`next.fullRedraw` → 全行 write-cells + `fullRedraw: true`（收缩时
  补 erase）；否则整行 diff，变行整行重写。ops = resources + 变行 write-cells
  + cursor（变化时）+ 变更 mode（浅比较，scrollRegion/progress 用 JSON）。
  `bytes` 用 writer 自己的 `encodePatchOperationsSync` 计算；`patchSeq` 为
  backend 内递增计数（start 重置）。`next.generation < activeGeneration` 抛
  RangeError。带 `images` 的 frame 抛 RangeError（图像字节走 compat write
  路径的已声明 marker，ImageStore plumbing 未接）。
- `stop(generation)`：旧 generation 直接忽略；main backend 额外 await
  `adapter.awaitStop()`（会话结束 barrier 由会话 owner 触发）。alt backend 的
  vendored TUI 拿到的是 **scoped `Terminal` facade**（`AltScreenTerminalScope`）：
  全部方法委托共享 adapter，唯 `stop()`/`awaitStop()` 为 scoped no-op——alt
  屏自己的 afterTerminalStop 字节（DEC 1049 退出 + 主屏内容恢复）就是该 scope
  的 teardown，会话接管不因 overlay 关闭而结束；`onScopeStop` 钩子供会话 owner
  在关闭后把 input 重新指回主屏 TUI（WP-04 接线）。

## 记录在案的与 pi `ProcessTerminal` 的偏差

1. `setTitle` 用 OSC 2（pi 用 OSC 0）：都设置 window title，OSC 0 顺带设 icon
   name；ansi builder 默认 scope 2。
2. `setProgress(true)` → OSC 9;4;**1**（normal）而非 pi 的 9;4;3
   （indeterminate）+ keepalive interval：pinned lifecycle progress op 无
   indeterminate 状态；fork 写路径里的 OSC 9;4;3 字节经 parser→sequence
   lane 原样round-trip。
3. `clearScreen()` 发 `\x1b[2J\x1b[1;1H`（pi 是 `\x1b[2J\x1b[H`）：CUP 缺省
   参数被规范化成显式 `1;1`，语义相同。
4. `clearLine()` 发 EL 2（`\x1b[2K`，整行擦除）而 pi 发 EL 0（`\x1b[K`，
   擦到行尾）：pinned lifecycle clear op 的固定编码；pi 自身在 TUI 渲染路径
   用的就是 EL 2（`piOutput.eraseLine()`），交互行为一致。
5. pi 三个 query（cell size / background color / color scheme）只负责发出
   query 字节；响应由 input 层 query grammar 检测，无 broker token 认领时
   丢弃——pi 侧响应消费者（`setCellDimensions`/terminal-colors 回调）在 dsh
   运行时不接线。
6. `TuiBase.stop()` 尾部 `afterTerminalStop` 的 write 会撞上已开始 teardown
   的 writer（`stopping`），这些字节按 `stopped` 丢弃计数而非错误——物理终
   端状态由 lifecycle cleanup 序列保证（VT modes 复位有集成测试断言）。
