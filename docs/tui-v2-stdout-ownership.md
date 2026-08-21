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

## 机器可读 ownership block（WP-09c1）

`pnpm verify:tui-v2 -- --check ownership` 从下列 roots 解析 runtime
import/export/dynamic-import 闭包，使用 TypeScript AST 扫描直接 stdout/stderr、
`console.*`、唯一 terminal stream、foreign-output guard、external child 和 control
sequence。所有命中必须恰好匹配一个 owner；controller 物理写入、旧路径、未登记命中
或登记项漂移都会失败。`pi.ts`、`ProcessTerminal`、`TuiMainScreen`、
`TuiAltScreen` 不得进入生产闭包；生产只通过收窄的 `pi-editor.ts` / `pi-input.ts`
复用 editor/input 纯逻辑。

```json
{
  "schemaVersion": 1,
  "ruleVersion": "tui-v2-ownership-v1",
  "hitHash": "b842627d44386fa96b4a5ae5f285183c03e691c45f25b7c9b93a9c9111402c29",
  "roots": [
    "bin/dsh-tui.js",
    "src/index.ts",
    "src/dsh-adapter/index.ts",
    "src/dsh-adapter/plugin.ts",
    "src/tui-v2/app/bootstrap.ts"
  ],
  "owners": [
    {
      "id": "launcher-pre-tui",
      "owner": "bin launcher",
      "files": ["bin/dsh-tui.js"],
      "kinds": ["console-write", "external-child"],
      "lifecycle": "before v2 bootstrap or after the inherited dsh child exits",
      "backpressure": "launcher diagnostics are finite lines; child stdio is inherited only while the child owns the process terminal",
      "cleanup": "launcher forwards child exit/signal and never coexists with an in-process TerminalWriter",
      "generation": "outside the v2 generation domain",
      "queue": "no frame queue; one foreground child"
    },
    {
      "id": "adapter-boundary-diagnostics",
      "owner": "dsh adapter bootstrap/update handoff",
      "files": ["src/dsh-adapter/index.ts", "src/dsh-adapter/plugin.ts"],
      "kinds": ["console-write", "stderr-write"],
      "lifecycle": "rename/upstream notices run before the first frame; update failures run after disposeRootAndThen",
      "backpressure": "finite diagnostic lines only; no terminal control payload",
      "cleanup": "active coordinator is stopped before update stderr and process exit",
      "generation": "pre-takeover or post-cleanup; never a live frame generation",
      "queue": "does not enter the writer queue"
    },
    {
      "id": "debug-diagnostics",
      "owner": "bounded opt-in diagnostic stderr",
      "files": ["src/utils/debug.ts"],
      "kinds": ["stderr-write"],
      "lifecycle": "only when DSH_TUI_DEBUG is explicitly enabled; inline foreign-output guard observes active writes",
      "backpressure": "one bounded message plus scalar JSON fields per call; no raw child bytes",
      "cleanup": "no listener/timer ownership; caller lifecycle ends emission",
      "generation": "diagnostic metadata is generation-neutral and never advances writer generation",
      "queue": "outside frame queue; inline damage is re-anchored"
    },
    {
      "id": "child-output-sanitizer",
      "owner": "ChildStderrGuard / external-action sanitizer",
      "files": ["src/dsh-adapter/childStderr.ts", "src/tui-v2/capabilities/external-actions.ts"],
      "kinds": ["control-sequence"],
      "lifecycle": "guard attaches with adapter effect and restores spawn at disposal; action sanitizer is controller-scoped",
      "backpressure": "child lines and action output are bounded before projection; regexes consume ANSI/OSC as data",
      "cleanup": "spawn patch and subscriptions are restored/stopped by their owner",
      "generation": "sanitized text only crosses the current controller generation",
      "queue": "never writes terminal bytes and never bypasses TerminalWriter"
    },
    {
      "id": "host-external-actions",
      "owner": "ShellCapability / EditorRunner / ClipboardCapability",
      "files": ["src/tui-v2/capabilities/node.ts", "src/utils/clipboard.ts", "src/utils/execFileNoThrow.ts"],
      "kinds": ["external-child"],
      "lifecycle": "shell/clipboard children are piped and projected; editor inherits tty only inside ScreenTakeover",
      "backpressure": "shell output is sanitized/capped; clipboard helpers have timeout; editor temporarily owns the tty",
      "cleanup": "AbortSignal/timeout sends SIGINT then SIGTERM; takeover finally restores terminal/input",
      "generation": "editor restore increments generation; late shell/clipboard results are fenced",
      "queue": "child output never enters a second terminal writer; projected results use bounded controller queues"
    },
    {
      "id": "post-cleanup-update-child",
      "owner": "RestartRunner after ScreenTakeover cleanup",
      "files": ["src/update.ts"],
      "kinds": ["external-child", "stderr-write"],
      "lifecycle": "update/restart runs only after coordinator cleanup and root disposal",
      "backpressure": "foreground child owns inherited stdio; captured stderr is finite-classified for one retry",
      "cleanup": "child close/error settles once and replacement process owns subsequent output",
      "generation": "old generation is stopped before spawn; no resume into the old writer",
      "queue": "no active frame queue during inherited child output"
    },
    {
      "id": "trusted-frame-control-builders",
      "owner": "cell/frame pipeline feeding TerminalWriter",
      "files": [
        "src/tui-v2/components/transcript/markdown.ts",
        "src/tui-v2/renderer/lines.ts",
        "src/tui-v2/terminal/ansi.ts"
      ],
      "kinds": ["control-sequence"],
      "lifecycle": "component strings are parsed into cells; only trusted ansi.ts builders can become writer control operations",
      "backpressure": "builders allocate bounded frame/control strings and never call a stream",
      "cleanup": "TerminalWriter owns reset/OSC close/mode cleanup",
      "generation": "writer validates generation on every patch/control",
      "queue": "all physical bytes enter the one writer FIFO"
    },
    {
      "id": "terminal-input-query-owner",
      "owner": "InputSource / QueryBroker",
      "files": ["src/tui-v2/terminal/input.ts", "src/tui-v2/terminal/query.ts"],
      "kinds": ["control-sequence"],
      "lifecycle": "input owns stdin while active; query tokens expire/cancel at stop or generation change",
      "backpressure": "bounded tokenizer ring and 150/300 ms query budgets",
      "cleanup": "input stop drops partial bytes; broker cancels pending tokens",
      "generation": "responses require opaque token and exact generation",
      "queue": "queries are emitted only through TerminalWriter's bounded control lane"
    },
    {
      "id": "vendored-editor-input-logic",
      "owner": "narrow pi Editor/StdinBuffer compatibility surface",
      "files": [
        "src/tui-v2/vendor/pi-tui/src/components/editor.ts",
        "src/tui-v2/vendor/pi-tui/src/dsh/pi-output-encoder.ts",
        "src/tui-v2/vendor/pi-tui/src/keys.ts",
        "src/tui-v2/vendor/pi-tui/src/stdin-buffer.ts",
        "src/tui-v2/vendor/pi-tui/src/terminal-colors.ts",
        "src/tui-v2/vendor/pi-tui/src/terminal-image.ts",
        "src/tui-v2/vendor/pi-tui/src/tui.ts",
        "src/tui-v2/vendor/pi-tui/src/utils.ts"
      ],
      "kinds": ["control-sequence", "terminal-stream-write"],
      "lifecycle": "production constructs only Editor and StdinBuffer with a coordinator-owned no-output host; dormant TuiBase methods retain an injected Terminal interface but the narrow facade exports no constructor for that owner",
      "backpressure": "the production pi-editor facade caps retained undo snapshots at 256; input raw diagnostics remain a bounded ring; literals are style/input parsers",
      "cleanup": "coordinator stops input and discards editor with the app; no ProcessTerminal is reachable",
      "generation": "input wrapper stamps generation; editor emits commands rather than terminal writes",
      "queue": "no physical stream method is exported by pi-editor.ts or pi-input.ts"
    },
    {
      "id": "inline-foreign-output-guard",
      "owner": "ForeignOutputGuard",
      "files": ["src/tui-v2/terminal/foreign-output.ts"],
      "kinds": ["stream-guard"],
      "lifecycle": "attached only for inline backend and detached before terminal cleanup",
      "backpressure": "forwards the original write result and counts only bytes/write count",
      "cleanup": "detach restores the exact prior write method without clobbering later patches",
      "generation": "foreign output schedules a damage redraw in the current generation",
      "queue": "writer proxy marks the sole sanctioned lane; foreign writes never create a second queue"
    },
    {
      "id": "unique-terminal-writer",
      "owner": "TerminalWriter",
      "files": ["src/tui-v2/terminal/writer.ts"],
      "kinds": ["terminal-stream-write"],
      "lifecycle": "created -> starting -> active -> stopping -> stopped with fail-before/after-takeover terminals",
      "backpressure": "one write in flight, queueDepth <= 2 frames, pending bytes <= 8 MiB, callback plus drain settlement",
      "cleanup": "stop blocks new work, drains/destroys by deadline, emits trusted cleanup bundle and clears queue",
      "generation": "watermark tuple and opaque quiesce barrier reject stale generations",
      "queue": "the only physical frame/query/control FIFO; stats expose current and peak depth/bytes"
    }
  ]
}
```
