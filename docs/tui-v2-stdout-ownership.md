# tui-v2 stdout/stderr ownership（WP-08f）

本文件冻结 external action 期间的 stream ownership。所有 action 都通过 coordinator 注入 capability；component、scene 和 controller 不得调用 `process.stdout.write`、`process.stderr.write` 或 `console.*`。

| 来源 | owner | 输出边界 | backpressure / cleanup |
| --- | --- | --- | --- |
| v2 frame/terminal control | `TerminalWriter` | Frame、trusted ANSI builder、OSC52 只进入唯一 writer | writer FIFO、8 MiB pending cap；lifecycle stop 负责 flush、cleanup bundle、raw/input drain |
| local `!`/`!!` shell | `ShellCapability` + `ShellController` | child stdin 为 closed/controlled；stdout/stderr 先清洗 ANSI/C0/C1、按 32k chars/256 lines 截断，再投影为 local rows/notice；command、env、原文输出不进 trace | timeout/SIGINT/SIGTERM 由 capability 处理；controller token 丢弃 late result；child 不继承 v2 writer |
| external editor | `ScreenTakeover('external-editor')` + `EditorRunner` | child 临时拥有 tty；文件 private dir/0600；saved text 在 restore 前读取；child stdout 不进入 Frame | takeover 先 quiesce writer、停止 input、park modes；finally 恢复 mode snapshot、input、generation++、full redraw；restore 错误只产诊断 |
| update/restart | `ScreenTakeover('update')` + `RestartRunner` | package manager/restart runner 输出不穿透 active frame；结果只保留 exit code/signal/error code | confirmation、cleanup、SIGTERM/cancel、late result 均 token 化；controller 不调用 `process.exit` |
| clipboard paste | `ClipboardCapability` | text/files/image 走 input controller；image 通过 `stageImage`/ImageStore；bytes 不进入 AppEvent/trace | busy latch、late guard、payload cap；错误/unsupported notice 诚实反馈 |
| clipboard copy / OSC52 | `ClipboardController` + `TerminalWriter` | 纯文本清洗/限长后由 `ansi.osc52Clipboard` 生成 trusted sequence；不拼接 raw OSC | profile `supportsOsc52 !== 'yes'` 时返回 unsupported；writer stale/error 不冒充 copied |
| channel/plugin notifications | `NotificationController` + dock mirror | bounded sanitized notification view；不写 transcript row cache，不触发 rows-reset | injected Clock timeout、sticky/dismiss/dedupe；stop 清 timer；inline 只在有限 dock/append lane 反馈 |
| diagnostics | coordinator diagnostic sink | machine-readable code、bounded scalar、hash/count；可写受控日志/stderr，由宿主决定 | 不阻塞 render/action；不得携带 command/env/secrets/clipboard bytes |
| inline foreign output | `ForeignOutputGuard` | 绕过 writer 的主屏写入只被计数，随后 damage re-anchor；不复制进 transcript | re-anchor 不发 ED3/DECSTBM、不增长 scrollback；stop detach 恢复原始 stream.write |

## inline/fullscreen 差异与 §15.1 边界

- fullscreen 的 nested overlay/fixed viewport 仍由 `FullscreenBackend` 承诺；child takeover 退出并恢复 alt-screen/modes 后执行一次 full redraw。
- inline 不伪装 fullscreen parity：历史 scrollback 只能 append-only，overlay picker/dialog 可能不可见但继续由 focused controller 吃键；不安全的 child transfer 应返回 unsupported，而不是把 child 输出混入 scrollback。
- inline shell output 若投影 transcript，只能通过 adapter 的 append-only local rows；任何直接 child stdout 都属于 foreign output，必须经 guard/re-anchor。
- OSC52 negotiation、鼠标底层 capability、宿主特定 probe 仍留 WP-08g；WP-08f 只调用 profile 与 trusted writer capability。
- image bytes 继续只存在 process-local ImageStore；external action trace 只记录 action kind/status/generation/hash/count，不记录 secrets、raw shell、env 或 bytes。
