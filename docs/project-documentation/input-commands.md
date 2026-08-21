# 输入处理、命令系统与持久历史

生产输入链是 v2-only：input source/tokenizer → `createInputController` →
`PromptEditor`/overlay/command controller → coordinator dispatch。旧 React/Ink
输入实现已删除；本文件后续旧行号只作为 WP-09a provenance，不是可运行入口。

## 输入模型

`src/tui-v2/controllers/input.ts` 负责 Ctrl+C/Ctrl+D/escape/redraw、paste、
help/history shortcuts 与 submit journal；`src/tui-v2/components/editor/prompt-editor.ts`
组合 vendored pi Editor，编辑器仍是 text/cursor/history 的唯一 owner。

| 键 | v2 行为 |
| --- | --- |
| ←/→、Home/End、word keys | pi Editor 光标/词边界 |
| Ctrl+C/D | working 时 interrupt；idle 时 clear/arm/exit funnel |
| Ctrl+L | journal `app/redraw`，下一帧 full redraw |
| Ctrl+R | 打开 history-search overlay |
| Ctrl+V | capability atomic paste，不把换行当 submit |
| Ctrl+X | external-editor capability/controller |
| Enter | `input/command` journal → channel submit |


## 键盘链路

```text
InputSource (v2 terminal/input.ts)
  -> tokenizer/query broker（key/paste/resize/mouse/query response）
  -> createInputController
  -> focused overlay/controller 或 PromptEditor
  -> AppEvent journal -> reducer/channel command -> scheduler
  -> frame builder -> terminal writer
```

raw mode、Kitty keyboard、bracketed paste 与 terminal query 都属于
`src/tui-v2/terminal/`；controller 不直接写 ANSI，也不调用 `process.exit`。
`Ctrl+C/D`、signal、stdin EOF、error 都进入 coordinator stop funnel，完成 mode
restore 后才写 resume marker。

## IME 避让：物理光标停放

v2 editor 通过 `Focusable.cursor` 发布 cell 坐标，frame builder 对 cursor 做边界
裁剪；因此 CJK/emoji 的显示宽度不会把 preedit 放到半个 grapheme 中。IME 的
composition protocol 仍由终端模拟器处理，本包只保证硬件 cursor 的确定位置。

全仓库**没有任何 compositionstart/update/end 或 beforeinput 等组合事件监听**
（grep 仅命中注释）；IME 组合期间的行为完全委托给终端：

- 终端在物理光标处渲染 IME preedit（src/ink/components/App.tsx:116-120 注释：
  "Enables IME composition at the input caret"；src/ink/ink.tsx:653-699：
  cursorDeclaration 在帧末解析为绝对坐标并发射 CUP 光标定位序列）。
- useDeclaredCursor（src/ink/hooks/use-declared-cursor.ts:5-12,42-62）：每次 commit
  无条件重声明以对抗兄弟交接与卸载清理。
- 视觉列而非字符索引（src/components/PromptInput.tsx:756-773）：CJK 字符占两个终端列，原始
  字符数会把物理光标停在字符中间导致 Windows Terminal 把拼音 preedit 画到
  周边文本上；caretVisualCol 用 stringWidth 计算。
- 空输入刻意不渲染 placeholder（src/components/PromptInput.tsx:34-41）：组合期间应用收不到
  任何输入事件（Windows Terminal 在 TSF 组合期间抑制键事件），空行空白是
  保证 preedit 无物可遮的唯一办法；空输入渲染为空白格上的反显块光标
  （`<Text inverse> </Text>`，src/components/PromptInput.tsx:908-916）。SearchBox 同款避让（src/components/SearchBox.tsx:5-11,
  38,68-76）：行首反显空白块 + 右侧 dim 对齐的 placeholder（"kept off the
  caret's cell"）。

## 粘贴双通道

| 通道 | 链路 | 位置 |
| --- | --- | --- |
| Bracketed paste | terminal input source 解码为 `paste` event；controller 通过 `insertPaste` 原子插入，换行永不触发 submit | `src/tui-v2/terminal/input.ts`, `src/tui-v2/controllers/input.ts` |
| Ctrl+V | `ClipboardCapability` 读取文本/文件引用，controller 以同一 atomic insertion seam 交给 editor | `src/tui-v2/controllers/clipboard.ts`, `src/utils/clipboard.ts` |

clipboard capability 失败只产生 notification，不越过 writer 写终端；相关输入、
OSC52 与 host capability coverage 由 v2 tests/host-capabilities check 负责。

## 工作态投递与 Esc 语义

| 键 | 工作态行为 | 位置 |
| --- | --- | --- |
| Enter | STEER：注入运行中回合下一步边界（Codex/pi 语义） | src/components/PromptInput.tsx:254-266 |
| Tab | follow-up 排队 | :272-284 |
| Ctrl+Enter | 中断并立即投递（注释：Windows Terminal 发送 CSI 13;5u / 13;1;5u） | :309-329 |
| Alt+Up | 取回最后一条 pending（经 channel.removePending，官方 inbox.remove 撤回，失败拒绝） | :291-303 |

Esc 语义分级（src/components/PromptInput.tsx:659-722）：关 help → 关命令菜单（清空）→ 只关
当前 @ token 菜单（fileEscRef）→ 工作且有 pending 时中断并立即投递 → 清空有
内容输入 → 双击 Esc：空输入开 rewind / 有输入清空，3s 内不重复则取消武装。
Chat 侧另在 :1149-1162 处理工作态 Esc（pending 投递或 channel.cancel）并
stopImmediatePropagation。

Enter 防抖（:159-160,419-425）：cmd 管线可能把一个 Enter 拆成 \r+\n 两次事件，
lastEnterAtRef 80ms 窗口内重复 Enter 被折叠；整行输入规则：input 含 \n 或 \r
时纯 CR/LF 视为 Enter，否则合并 value+input 后按命令唯一匹配→运行，否则提交
（:449-469，注释："Windows ConPTY pipelines deliver whole lines with the Enter
key lost"）。

## 命令系统

命令解析（src/commands.ts:83-89）：parseCommandName 正则
`^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])` 取首个 token，rawInput 保留名字后的原文
（`/plan off` → plan + ' off'）；tryRunCommand 要求文本以 '/' 开头、名字在
channel.commandList（本地 39 条 + 插件合并，见
[lifecycle.md](lifecycle.md#命令分发链)）中，处理成功才清空输入并写历史。

命令菜单（src/components/PromptInput.tsx:168-175）：`value.startsWith('/')` 触发
filterCommands（prefix 为 '/' 后整段文本，trim+lowercase，按 name.startsWith
匹配）；overlayOpen 还需 !helpOpen && !selectionActive && !value.includes('\n')。
命令菜单打开时 Enter 执行选中项（绝不发送 '/mo'）；Tab 补全为 `/<name> `；
Shift+Tab 在 Tab 分支前处理（解析器把 backtab 报为 key.tab+key.shift），循环
推理 effort（:491-494，"dsh parity"）。

### /rewind（issue #43，pr-55）

/rewind 于 LOCAL_COMMANDS 注册（src/commands.ts:31），runCommand case 'rewind'
复用双击 Esc 的 openRewind() 选择器（src/screens/Chat.tsx:513-518）。rewindTo 机制自
0.1.0（809591d）已存在（src/channel.ts:372-375 接口注释 "CC's double-Esc rewind"：
fork 会话、换新 agent、返回可编辑文本），**pr-55 只加命令入口**。

```text
/rewind（或双击 Esc）-> openRewind（src/screens/Chat.tsx:736-750）：
   候选行 = channel.rows 筛 kind==='user' && label===undefined 倒序；
   无候选时 notify 'Nothing to rewind yet'
  -> src/components/RewindPicker（src/screens/Chat.tsx:1363-1371）：Enter 选中 -> 确认态 Enter 执行
     performRewind（:1101-1105）
  -> channel.rewindTo(row)（src/channel.ts:1219-1348）：
     working 时 cancel + waitForTurnEnd（30s）
     -> 回扫 turn/start 定 boundary = event.seq - 1（DSH 事件序
        turn/start→user/message→…→turn/end，消息自身 seq 在 turn 内，
        在此 fork 会命中 OPEN_TURN）
     -> sessions.fork(agent.session, boundary) 取 seed
     -> agents.create 新 child（childId=randomUUID；meta 记 parentSession /
        seedLength / agentPreset；agentOptions 沿用现用 provider/model——
        "a /model switch must survive it (issue #30)"，回退不恢复旧模型）
     -> 重置块：清空 rows / todos / goal / sessionTitle / tokens /
        lastUserText / spinner，再按 coalesceReplayEvents(seed) 重放
     -> bindAgent / refreshCommandList / refreshLoadedContext /
        touchSession(childId) / dispose 旧 handle
  -> 返回 row.text -> setHistoryFill（src/screens/Chat.tsx:754-758，notify 'Rewound —
     edit and press Enter to resend'）-> PromptInput fillText 效果
     （:147-153）写回输入框，用户编辑后 Enter 重发
```

### /new 一次生效（issue #25，pr-55）

- 引入：bfc46fb（08-06）在 runCommand case 'new' 加 CC 式确认——hasContent 且
  newConfirmRef 未 arm 时置标记、notify 'Press /new again to confirm'、return
  true（不调用 newSession）；4 秒后自动解除。
- 根因：会话有 user/assistant 行时第一次 /new 永远只 arm，必须 4 秒内再输
  一次才执行。
- 修复：6aa8598（pr-55）删除 newConfirmRef 与整个门控，case 'new' 直接
  `void channel.newSession()`（src/screens/Chat.tsx:439-448）；取舍依据：newSession 非破坏，
  旧会话仍持久化于 JSONL 会话库、/resume 可找回，"二次确认只是纯摩擦"。
- 合入：dc678d8（Merge pr-55）；channel.newSession() 实现未改动
  （715b60f..dc678d8 对 src/channel.ts diff 为空）。
- newSession（src/channel.ts:1456-1574）：working 时拒绝；composePreset
  （configuredPreset ?? readPresetPref）+ resolveModelRoute+validateModelRoute
  → agents.create → 重置块 → clearResumeTarget → touchSession → dispose 旧
  handle。

### /compact

调度：case 'compact'（src/screens/Chat.tsx:457-459）→ channel.compact()（src/channel.ts:1922-1961）：
经 serviceForAgent 解析 dsh-compaction 服务；缺服务 notify 'Compaction
unavailable'；working 时拒绝；compactNow(agent, signal) 异步压缩。渲染
（:2491-2534）：checkpoint user/message（source {kind:'plugin', plugin:'compact'}）
→ notice 'Conversation compacted' + kind 'compact' 摘要行，并立即重置
contextSegments/tokens.input/lastUsage/contextWarned。

与 rewind 的关系：两者都依赖持久化会话日志（cordis.yml:158-160 "Durable
session log... /resume and rewind both rely on this backend"）；compact 以摘要
替换日志历史 → 压缩点之前的 user 消息从日志消失；rewind picker 只列 user 行
而 checkpoint 渲染为 notice/compact 非 user 行 → **压缩后无法回退到压缩点之前**
（推断，无文档或测试明确声明）。

### 命令可见性

LOCAL_COMMANDS 注册后自动可见：'/' 建议 overlay 用
filterCommands(value, channel.commandList)（src/components/PromptInput.tsx:168-172）；'?'
帮助菜单 <HelpMenu commands={channel.commandList} />（:844）。/rewind 注册后
两处自动出现（53016e8 提交信息确认）。

## Ctrl+R 历史搜索

Chat 捕获 `key.ctrl && input === 'r' && !helpOpen`（src/screens/Chat.tsx:1128-1135）：
loadHistory() 读 history.jsonl 反转（最新在前）；过滤为不区分大小写子串
（:722-725）。对话框键盘在 Chat（:1048-1097）：↑/↓ 或重复 Ctrl+R 移动 focus、
Enter 填充、Esc/Ctrl+C/Ctrl+D 取消、其余键编辑 query；HistorySearchDialog
自身无 useInput（:11-17 注释 "Keyboard handling lives in the caller (Chat)"）。
setHistoryFill(entry.text) → PromptInput fillText effect 替换输入并置光标到
末尾（src/components/PromptInput.tsx:146-153，lastFill ref 去重）。对话框打开时 PromptInput
因 promptSelectionActive（含 historyOpen 等所有模态）忽略全部键。

## 冲突

| 项 | 两侧 |
| --- | --- |
| 监听者顺序注释存疑 | src/components/PromptInput.tsx:47-52 注释声称 "Chat's useInput listener runs BEFORE this component's (EventEmitter registration order)"；但监听注册在 useEffect（子先父后提交），PromptInput（子）应先注册先执行——与注释矛盾。无法运行验证；即便顺序相反，interruptAndDeliver 的 interruptSeq token 会丢弃重复请求，不能从无双投递反推顺序 |
| README 图片粘贴口径 | README.md:88 宣称 Ctrl+V "Explorer 复制的文件/图片 → 插入文件路径"；代码只对 FileDropList 产出路径，浏览器内复制的位图既非文件也非文本，Get-Clipboard -Raw 返回空 → 提示"剪贴板为空" |
| 历史文档口径 | docs/interaction.md:15 称 ↑/↓ "浏览历史"未注明范围；代码中 ↑/↓ 仅会话内 50 条，持久化 200 条历史只有 Ctrl+R 能检索 |
| /rewind 文档缺失 | /rewind 已注册并出现在 / 菜单与 ? 帮助，但 README.md / docs/interaction.md 只记载双击 Esc 的 rewind 入口；dc678d8 之后无文档提交 |
| steering 过滤空操作 | src/screens/Chat.tsx:727-728 注释称排除 steering 侧问（row.label === undefined），但 src/ 无任何代码给 user 行设置 label——过滤条件恒真 |
| v0.4.1 标签歧义 | 基线 HEAD b2f4087（package.json 0.4.1）含 pr-55；git tag v0.4.1 指向 eeca418（不含 dc678d8）。publish.yml 规定 tag==package.json version 才发布，按 tag 发布的 npm 0.4.1 很可能不含这两个改动（注册表内容未离线核验） |

## 未验证事项

- Chat 与 PromptInput 两个 useInput 监听者的实际执行顺序（注释与 React effect
  语义相抵触，纯静态分析两说皆可自洽，无测试可证）。
- IME 组合期间对会照常发送键事件的终端（部分 Linux IME 配置）行为如何。
- Ctrl+Enter 在既不支持 kitty 也不支持 modifyOtherKeys 的终端上是否还能被
  识别（parse-keypress 无老式终端兜底映射）。
- Ctrl+V 在无 PowerShell 环境（WSL 直启或 SSH 的 Linux 终端）下是否仍工作
  （clipboard.ts 硬编码 powershell 可执行名，无平台条件分支）。
- compact 之后能否回退到压缩点之前（代码推断为不能，无文档或测试声明）。
- 实际 profile 安装的会话库后端（见 [session-context.md](session-context.md)）。

相关文档：[lifecycle.md](lifecycle.md)（命令分发链）、
[rendering.md](rendering.md)（输入相关渲染）、
[model-route.md](model-route.md)（/model 命令）、
[ink-core.md](ink-core.md)（键盘解析底层）、[unknowns.md](unknowns.md)。
