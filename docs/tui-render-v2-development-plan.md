# dsh-TUI v2 渲染重构开发计划

> **文档状态：** Architecture decision record + single-shot execution plan；工作包只表达实现依赖，不产生中间版本或临时运行模式；当前计划审计无未登记 P0/P1，最终合并/发布前仍必须通过统一 CI artifact 验收
> **编写分支：** `refactor/tui-render-v3`
> **工作目录：** `/home/sisct/Code/projects/dsh-TUI/.claude/worktrees/tui-render-v3-plan`
> **基线提交：** `0f2c9da` (`main`)
> **目标：** 在保留 DSH/Cordis 领域能力的前提下，重写 dsh-TUI 的渲染热路径，最终移除 React reconciler、Yoga 和自维护 Ink DOM 渲染链。

本文是一次性完整替换的实施文档，不是对现有实现的简单描述。所有工作在一个实现分支/一次 breaking release 中完成；下文的工作包只是依赖关系和责任边界，不代表可发布的中间阶段，也不要求提交无行为价值的脚手架改动。最终代码不得保留 v1/v2 双跑、临时 fallback 或仅为迁移存在的运行时分支。后续代码、测试、评审和发布都以本文的边界和统一验收标准为准。若实现过程中需要偏离本文，必须先在本文的“决策记录”中补充原因、影响和回滚方式。本文中的路径、命令和版本以当前仓库及其 CI 为准；不能用“未来会有的脚本”作为验收证据。

### 0.1 当前仓库的可执行约束

- 当前包使用 `pnpm compile`、`pnpm verify:build` 和大量 `scripts/verify-*`/`scripts/repro-*` 回归脚本；没有根级 `test` 或 `lint` 命令。v2 必须先新增明确的测试入口，再把它接入 `.github/workflows/ci.yml`，不能只在文档中声明“有单测”。
- 包声明支持 Node `^22.19 || >=24`，当前 CI 只运行 Node 24。v2 的 build、unit/replay/virtual-terminal 测试必须至少在 Node 22.19 和 Node 24 各跑一次；不能把 Node 24 的行为当作唯一基线。
- 当前 `src/ui.ts`、`package.json` 的 `./scenes`/`./jsx-runtime` exports、`src/scenes.ts` 和 plugin host 属于公开/扩展边界。本次一次性实现采用 breaking release：所有仓库内 scene/plugin fixture 在同一变更中迁移到 `SceneV2`，并在同一变更中删除 React/JSX 热路径和旧 exports；外部插件需要按迁移文档升级，不在最终包中保留 legacy React runtime。
- 当前 `package.json` 的 `files` 不会自动发布 `src/tui-v2` 之外的 license、patch ledger 或诊断 schema。最终 runtime tarball 必须带 vendored `LICENSE`/`NOTICE`；完整 source/hash/patch ledger 至少随仓库或 source release 发布，若 vendored source 进入 tarball 则 ledger/hash 也必须随之发布。路径和检查规则属于 WP-02/WP-07 的完成条件。
- 当前 `@xterm/headless` 声明为 `^6.0.0`、lockfile 解析为 `6.0.0`；WP-01 将 manifest 改为 exact `6.0.0`（或先提交 ADR 说明替代版本），并在 conformance 报告中记录 xterm 与本地 parser 的支持边界。
- 宽度和测试 loader 也必须 exact pin：当前 lockfile 解析为 `get-east-asian-width 1.6.0`、`tsx 4.23.12`，WP-01 将 manifest 从 `^1.0.0`/`^4.0.0` 改为 `1.6.0`/`4.23.12`（若升级必须先更新 ADR、lockfile hash 和双 Node 报告）。最终验收记录完整 lockfile SHA-256、Node loader 版本和 package manager 版本；不能只依赖 semver range 的解析结果。

缺陷严重性在本文中固定为：**P0** = 数据/会话丢失、任意 raw/alternate/mouse/paste 状态泄漏、进程无法退出、未清洗控制序列注入、崩溃或安全边界绕过；**P1** = cell/mode/cursor 错误、输入/滚动/overlay 关键行为错误、回放不等价、资源或 backpressure 门槛失败；**P2** = 只影响未承诺能力的视觉差异、诊断缺字段或文案问题。P0/P1 阻断最终合并和发布，P2 必须登记 owner 和 release；不存在“先带病发布、之后再切换”的中间出口。

### 0.2 参考实现快照

本轮审查观察到：pi 的 `packages/tui` 为 `0.84.2`（仓库 `https://github.com/earendil-works/pi`，提交 `086c32e74530564922d011ade23ff582c9d63116`），Kimi Code 的 vendored `packages/pi-tui` 为 `0.84.3`（仓库提交 `1ab19190e9bd2f5bb5c40c8ba58fc121da6b4941`，其 `AGENTS.md` 记录上游基线 `0.80.2` 和本地差异）。本计划锁定 pi `packages/tui` 的上述 commit 作为唯一默认 source；Kimi 目录只作行为/patch 参考，不得混用其文件。WP-02 需把该 source（含 `native/win32`、`native/darwin` 等实际 vendored 文件）、包版本、每个文件 hash、依赖版本和 MIT/NOTICE 路径写入仓库 ledger；若改用 Kimi source，必须先提交 ADR、全量差异和重新 pin，不能以“后续锁定”通过最终验收。

Kimi `AGENTS.md` 列出的候选局部修复包括：单 grapheme 窄宽换行递归保护、Container 宽度 clamp、超宽行裁剪、负宽 `repeat` 防护、steady-frame processed-line reuse、CJK URL 边界、inline slash autocomplete 以及 completion Enter 不提交。它们只进入 dsh 的 fork patch ledger，逐项以本项目的 width/profile/回放测试验证；不能因为“参考实现已有”就直接复制。

Kimi 当前通过 `KIMI_CODE_TUI_FULL_SCREEN=1` 实验开关启用 fullscreen；dsh 不复制这个默认假设。fullscreen/inline 两个 backend 都在本次实现中完成，最终默认配置和 inline 降级说明随同一版本发布，不通过长期实验开关或灰度切换。

### 0.3 评审闭环记录

| 轮次 | 输入 | 结论 | 文档动作 |
| --- | --- | --- | --- |
| 1 | 架构、运行时、测试三路 review；当前仓库/CI/pi/Kimi 源码 | 测试入口、回滚、oracle、发布内容、生命周期和 guard 范围仍不可执行 | 本轮补充可执行命令、状态机、独立 golden、迁移台账和发布 gate |
| 2 | 第一轮修订后的同样三路 review；契约、最终验收、回滚、plugin scene、stdout ownership 和 row identity 复核 | 无 P0/P1；剩余事项均为实现时必须落档的具体任务 | 增加 versioned schema、ownership/scene 迁移台账、可执行 patch/control 类型，关闭评审环 |
| 3 | 主 agent 结构检查 + 测试/运行时独立复核 | 发现测试 runner、query/writer、compare、frame resources/modes、identity/reset、scene/takeover、发布 artifact 等 P1/P2 缺口 | 逐项补充可执行 contract；在下一轮复核确认前不关闭评审 |
| 4 | 独立 arch/test review；Node 26 reporter 实测、当前 package verifier/workflow 对照 | 发现 custom reporter、deep immutable、query token/register、pi stop barrier、scene register API、V1 capture、image/mouse canonical、tarball producer 等 P1/P2 缺口 | 补 custom reporter/verified-tarball wrapper、deep readonly/freeze、opaque token registry、awaitStop、最终 `register` API、离屏 capture、图片/鼠标 canonical 和 CI integration gate；修订后继续自审 |
| 5 | 第四轮修订后的 contract、Node 命令、路径、schema 和工作树审计 | 未发现新的 P0/P1；剩余差异均是实现时必须按本文产物证明的工作 | 关闭计划 review 环；保留最终验收、机器化 regression matrix 和 runtime/package gates 作为实施阻断 |

---

## 1. 执行摘要

### 1.1 最终技术决策

1. **应用架构参考 Kimi Code 的分层，不复制其实现假设：** Kimi 当前是可变 `TUIState` 加 controllers 直接更新，并没有统一 reducer 或纯事件回放模型。dsh-TUI 自己新增不可变 snapshot、纯 reducer 和可序列化事件；coordinator 只负责组装和生命周期，controllers 负责副作用和事件编排，components 只负责展示和局部输入。
2. **默认渲染底座采用 pinned、vendored 的 `pi-tui` fork：** 从明确的上游提交开始，复制所需源码并保留 MIT 版权/许可信息；每一个本地差异都必须有回归测试。
3. **渲染热路径不再使用 React、`react-reconciler` 或 Yoga：** 组件直接按宽度生成终端行，经过统一宽度处理、compositor 和差分规划后写入终端。
4. **fullscreen 与 inline 是两个 renderer/backend：** 共享 UI model、selectors 和展示组件，不共享物理屏幕更新算法。fullscreen 是正确性参考实现和最终优先模式，inline 是功能受限的兼容模式。
5. **OpenTUI 只参加受控 bake-off：** 只比较 imperative core，不接入 OpenTUI React/Solid binding；若没有明确的性能或兼容性优势，不改变默认方案。
6. **Session log 仍是唯一业务真相：** UI state 只保存交互状态、投影引用、滚动、弹窗、编辑器和当前流式增量，不复制一份无限增长的完整会话。

### 1.2 成功标准

重构完成不是“换了一个库”，而是以下行为可以从干净基线稳定重放：欢迎页、用户输入、assistant streaming、工具调用和结果、审批/提问、滚动、弹窗移动/缩放/关闭、resize、CJK/emoji、Ctrl+C、异常退出和终端恢复。所有关键结果以虚拟终端的 **cell grid** 比较为准，而不是只比较 ANSI 字符串快照。

### 1.3 明确不做的事情

- 不复制 Kimi Code 的 Agent、SDK、Session 或业务模型。
- 不在旧 Ink/Yoga 之上继续增加大型能力。
- 不把 OpenTUI native runtime、Go Bubble Tea 或 Rust Ratatui 作为本次默认运行时。
- 不在最终包中保留两套完整 UI 或旧 renderer 热路径；旧实现只允许作为隔离的离线 compare 输入，外部 rollback 使用上一发布包，不作为当前进程的运行时 fallback。
- 不用无上限缓存、完整 frame 历史、完整 session 快照或每个 token 一个永久对象换取短期性能。

---

## 2. 现状基线与问题证据

### 2.1 当前实际渲染链路

当前主链路可以概括为：

```text
DSH/Cordis session event
  -> src/dsh-adapter/channel.ts
  -> src/screens/Chat.tsx
  -> React element tree
  -> src/ink/reconciler.ts
  -> 自维护 DOM + Yoga layout
  -> src/ink/render-node-to-output.ts
  -> Screen/cell buffer + log-update diff
  -> src/ink/terminal.ts
  -> stdout
```

入口和关键文件：

| 责任 | 当前位置 | 重构含义 |
| --- | --- | --- |
| 公共 UI facade | `src/ui.ts` | 现有 React/JSX facade；同一变更改为 v2 facade 并删除旧 exports |
| 生产启动/退出 | `src/dsh-adapter/plugin.ts`、`src/index.ts`、`scripts/run.ts` | TTY 校验、service 注册、Agent 创建/恢复、React mount、update restart、stderr guard、teardown/退出区分；必须迁移到 v2 bootstrap/coordinator |
| 主聊天屏幕 | `src/screens/Chat.tsx` | 当前承担 coordinator、订阅、交互、业务分支和布局；必须拆解 |
| DSH UI projection | `src/dsh-adapter/channel.ts` | 继续提供领域适配，但改为稳定的 event/snapshot seam |
| Ink root/生命周期 | `src/ink/root.ts`、`src/ink/ink.tsx` | 仅供离线基线对照；在本次变更中删除 |
| reconciler/DOM/Yoga | `src/ink/reconciler.ts`、`src/ink/dom.ts`、`src/native-ts/yoga-layout/` | v2 不得被新组件依赖 |
| 终端协议 | `src/ink/terminal.ts`、`src/ink/termio/` | 抽取为唯一 `TerminalWriter`/lifecycle 所有者 |
| 视觉组件 | `src/components/` | 按消息、编辑器、chrome、dialog、pane 分批改为 line component |
| 其他场景 | `src/screens/SessionBrowser.tsx`、`Settings.tsx`、`TrajectoryScene.tsx` | 在本次变更中迁移到共享 component/overlay contract |

截至基线的规模信号：

- `src/screens/Chat.tsx`：约 2,433 行、105 KB。
- `src/dsh-adapter/channel.ts`：约 5,118 行、225 KB。
- `src/ink/ink.tsx`：约 1,898 行、261 KB。
- `src/ink/`：同时维护 DOM、reconciler、Yoga bridge、cell screen、ANSI/OSC、焦点、选择、滚动、差分、终端查询和输入协议。
- 当前仓库已有渲染审计文档 `docs/project-documentation/rendering.md`、`ink-core.md` 和 `ACCEPTANCE.md`，其中记录了双层节流、虚拟化、收缩帧重画、CJK 宽度缓存以及当前残留问题。这些文档是故障语料来源，不是 v2 的架构约束。

### 2.2 已确认的高风险类别

#### A. 浮层残影和污染帧

当前 absolute node、selection、resize、SIGCONT、alt-screen 进入以及强制重绘会修改或废弃前一帧。`prevFrameContaminated`、absolute removal 保护、重遍历等规则是在弥补一个模型问题：旧的 previous frame 可能已经包含了浮层覆盖后的像素，无法恢复被覆盖的 base 内容。

**v2 原则：** base frame、overlay layer、selection layer、cursor 独立构建；关闭或缩小浮层时重新合成 base，不从旧最终帧猜测底层。

#### B. 长会话内存增长

长会话同时存在 session/event、完整上下文、React dev/reconciler 对象、测量和字符缓存、流式字符串切片以及 frame 相关状态。已有宽度缓存和字符串 detach 修复不能解决整体所有权不清的问题。

**v2 原则：** 每一项缓存都声明容量、计量单位、淘汰策略和清空时机；完成行不可变；流式行是唯一高频变化源；trace、debug ring buffer 和 snapshot 均有硬上限。

#### C. CJK、emoji、ZWJ 和终端宽度不一致

组件、Markdown、编辑器、差分和后端若各自测量宽度，应用计算的列坐标可能与 ConPTY、Windows Terminal、tmux 或 SSH 里的实际 cell 不一致。

**v2 原则：** 所有宽度都经过一个 `grapheme -> terminal profile -> cell sequence` 管线；最终输出前强制保证任何物理行不超过 viewport width。

#### D. 流式更新优先级错误

流式 chunk 可能触发 channel emit、React commit、Yoga layout 和多个 scheduleRender。若把每个 chunk 当作同等重要的同步更新，输入、Ctrl+C、resize 会排在大量 token 后面。

**v2 原则：** 统一 `RenderScheduler`，输入和退出为高优先级，stream chunk 按 16--33 ms 合并，resize 是事务型全量失效，writer 串行且有 backpressure。

#### E. inline/fullscreen 语义混杂

主屏 scrollback 与 alternate screen 的光标、滚动、清理、残影和退出语义不同。用 `if (fullscreen)` 在同一个 writer 里堆条件会继续扩大隐含状态机。

**v2 原则：** `TuiMainScreen` 和 `TuiAltScreen` 实现同一 backend contract，但各自拥有物理更新算法和生命周期策略。

---

## 3. 目标、非目标与不变量

### 3.1 产品目标

1. 聊天 transcript 在长流式会话中稳定、可滚动、可恢复。
2. 编辑器输入低延迟，Ctrl+C、粘贴、组合键、Kitty keyboard protocol 在支持的终端中行为一致。
3. 工具调用、工具输出、Markdown、diff、审批、提问、状态栏、任务/目标和插件 UI 有明确的展示 contract。
4. 浮层任意移动、缩放、嵌套、关闭后，base 内容完全恢复。
5. resize、终端挂起/恢复、异常退出后不留下 raw mode、鼠标、paste、alternate screen 或同步输出状态。
6. 失败可通过脱敏 trace 和虚拟终端重放，不依赖人工“看起来正常”。

### 3.2 工程非目标

- v2 不改变 DSH session schema、Cordis 协议、Agent 行为和工具权限模型。
- v2 不把 UI 组件直接暴露给 DSH/SDK；领域对象只能通过 adapter 投影进入 UI。
- v2 不承诺所有终端的高级能力完全一致；不支持的能力必须由 profile 明确标记并走保守路径。
- 所有已承诺的视觉能力都必须在本次变更中迁移；核心纵向切片和终端正确性是统一验收的一部分，不是可单独发布的先行版本。

### 3.3 必须保持的不变量

| 编号 | 不变量 | 违反时的处理 |
| --- | --- | --- |
| I-01 | Durable session log 是业务内容真相；通知、activity、pending、local rows 属于 transient projection | UI 只能持有有界 projection、引用和有限流式增量；replay 必须声明哪些 transient state 由事件重建 |
| I-02 | 整个进程只有一个 stdout writer | 其他模块通过事件/通知请求写入 |
| I-03 | 终端生命周期控制序列的 owner 只有 `terminal/`/writer | SGR、OSC 8/image payload、测试 fixture 和脱敏文本按 allowlist 处理；新增 raw CSI/OSC/DEC 不能绕过 writer |
| I-04 | 任意时刻最多一个 render pass 和一个 write pass | scheduler 丢弃过期 frame，writer 串行化 |
| I-05 | 每个 row snapshot 不可变；running -> settled/tool result 通过新 revision/新 snapshot 表示 | cache key 可以稳定，禁止完成后原位修改；旧 snapshot 仍可由 trace 引用 |
| I-06 | 所有物理行宽度 `<= viewport.width` | 超宽时裁剪或回退 full redraw，不允许 throw 到用户 |
| I-07 | overlay 从独立 base 合成 | 禁止从 previous final frame 恢复浮层下内容 |
| I-08 | 缓存有容量和淘汰策略 | 缺少声明的 cache 不得合入 |
| I-09 | resize 是原子事务 | 更新 profile/size、失效缓存、重算、提交 frame 不能被中间帧打断 |
| I-10 | 任何退出路径执行 terminal cleanup | Ctrl+C、SIGINT、SIGTERM、异常、stdin close、update restart 都覆盖 |
| I-11 | UI component 不导入 Cordis、DSH session、Agent | 只能接收类型化 ViewModel 和 dispatch callback |
| I-12 | 未知终端能力采用保守路径 | 关闭高级序列、增加 full redraw，不猜测支持情况 |

---

## 4. 目标架构

### 4.1 总体数据流

```text
DSH / Cordis / Session log
          |
          v
  dsh-adapter event bridge
  (normalization + side effects)
          |
          v
       AppEvent
          |
          v
  UI model reducer/state  <---- user input / controller commands
          |
          v
      selectors
          |
          v
      ViewModel
          |
          v
  line components / local interaction
          |
          v
  base renderer -> overlay compositor -> cell/frame validation
          |
          v
       DiffPlanner
          |
       +--+----------------+
       |                   |
       v                   v
  TuiAltScreen        TuiMainScreen
       |                   |
       +---------+---------+
                 v
          TerminalWriter
                 |
               stdout
```

### 4.2 目录规划

本次实现先放在当前单包的 `src/tui-v2/`，不为重构引入无关的 workspace 拆分；最终依赖和发布边界在同一变更中一次性确定。目录结构如下（`vendor/pi-tui` 的许可证文件与 ledger 必须随源代码保存）：

```text
src/tui-v2/
  vendor/pi-tui/             # 唯一 pinned source；含 LICENSE/NOTICE/PATCH-LEDGER.md
  app/
    bootstrap.ts              # 创建 adapter、model、controllers、renderer
    coordinator.ts            # 只编排生命周期，不承载业务规则
    modes.ts                  # inline/fullscreen backend 选择
  model/
    events.ts                 # AppEvent、输入事件、生命周期事件
    state.ts                  # UiState，不持有 DSH service
    reducer.ts                # 纯状态转换
    selectors.ts              # transcript/dock/modal/editor ViewModel
    projections.ts            # ChatRow/session event -> UI projection
    revisions.ts              # row/document revision 分配
  controllers/
    session-events.ts         # session event -> AppEvent
    replay.ts                 # resume/rewind/replay
    streaming.ts              # chunk 聚合、完成、取消
    input.ts                  # 键盘/粘贴/鼠标命令路由
    dialogs.ts                # approval/question/plugin dialog 生命周期
    commands.ts               # slash/workspace/plugin commands
    scrolling.ts              # viewport、new-message、load older
    terminal-lifecycle.ts     # resize/signal/cleanup orchestration
  renderer/
    component.ts              # Component/Focusable/Overlay contracts
    lines.ts                  # styled line 和 cell 预处理
    layout.ts                 # stack/v-stack/scroll geometry
    base-renderer.ts          # transcript + editor + chrome
    compositor.ts              # base + overlays + selection + cursor
    frame.ts                   # Frame/CellGrid/Damage/FrameMetadata
    diff-planner.ts            # Frame -> terminal operations
    scheduler.ts               # 优先级、合并、丢弃过期 frame
    cache.ts                   # 有界 row/line/measurement cache
  terminal/
    profile.ts                 # capability detection + TerminalProfile
    writer.ts                  # 唯一 stdout writer、backpressure
    input.ts                   # stdin tokenizer、paste、kitty keyboard
    lifecycle.ts               # raw mode、alt screen、mouse、cursor、cleanup
    main-screen.ts             # inline/main-screen backend
    alt-screen.ts              # fullscreen/alternate-screen backend
    ansi.ts                    # 内部控制序列构造和清洗
  components/
    transcript/                # user/assistant/reasoning/tool/notice rows
    editor/                    # prompt、completion、history
    chrome/                    # logo、status、activity、footer
    dialogs/                   # approval、question、picker、help
    panes/                     # queue、activity、context、goal/todo
    media/                     # markdown、code、diff、image
  testkit/
    trace.ts                   # JSONL trace schema/read/write
    virtual-terminal.ts       # xterm/headless adapter + cell grid
    frame-assert.ts            # full render vs diff replay
    terminal-profiles.ts       # deterministic terminal profiles
    fixtures/                  # 脱敏事件和预期 grid
    benchmarks.ts              # frame/input/memory benchmark harness
tools/tui-v2-baseline/
  capture.ts                   # 独立旧实现离线 capture；不进入 runtime/tarball
  compare-harness.ts           # baseline artifact 与最终 renderer 对照
```

### 4.3 依赖方向

```text
model <- controllers <- app
model -> selectors -> components
components -> renderer contracts only
renderer -> terminal contracts only
terminal -> node process/streams only
dsh-adapter -> model event bridge; never imported by components
```

禁止反向依赖：

- `components/**` 禁止导入 `@deepseek-ai/*`、`src/dsh-adapter/**`、`process.stdout`。
- `renderer/**` 禁止导入 Cordis、session、Agent、filesystem 或网络模块。
- `controllers/**` 不直接写 stdout，不构造 ANSI，不修改 component 内部状态。
- `terminal/**` 不解析 DSH 业务事件。
- `model/reducer.ts` 不执行异步副作用、I/O、定时器或随机逻辑。

---

## 5. 核心接口与数据契约

以下接口是实施目标。字段可在实现时细化，但不能重新引入隐式全局状态。

### 5.1 Component contract

```ts
export interface Component {
  /** 根据当前 viewport 宽度生成带 ANSI 样式的逻辑行。 */
  render(width: number): string[]
  /** 主题、宽度、数据或终端 profile 改变时丢弃局部缓存。 */
  invalidate(): void
  /** 获得焦点时处理原始输入；未实现表示不可交互。 */
  handleInput?(data: string | TerminalInputEvent): void
  /** 是否需要 Kitty key-release 事件。 */
  wantsKeyRelease?: boolean
}

export interface Focusable {
  focused: boolean
  /** focused component emits a zero-width cursor marker or an explicit cursor position */
  cursor?: { x: number; y: number; visible: boolean }
}

export interface OverlayOptions {
  anchor?: OverlayAnchor
  minWidth?: number | `${number}%`
  width?: number | `${number}%`
  maxHeight?: number | `${number}%`
  row?: number | `${number}%`
  col?: number | `${number}%`
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number }
  offsetX?: number
  offsetY?: number
  visible?: boolean | ((termWidth: number, termHeight: number) => boolean)
  nonCapturing?: boolean
}

export interface Overlay extends Component {
  readonly options: OverlayOptions
  onClose?(reason: 'user' | 'teardown' | 'error'): void | Promise<void>
}
```

`renderer/component.ts` 通过 `import type { OverlayAnchor } from '../model/schema.js'` 引用锚点；component/overlay 的 `visible` 回调只存在于进程内 contract，进入 `OverlayState` 时必须归一化为布尔值，避免把函数写进 event/trace。

`OverlayState` 的归一化规则是 `captureInput === !nonCapturing`；输入捕获层必须显式为 `{ captureInput: true, nonCapturing: false }`，被动装饰层必须为 `{ captureInput: false, nonCapturing: true }`。输入 `{ captureInput: true, nonCapturing: true }` 或相反组合在 schema 校验时拒绝，不能由 renderer 猜测。

组件只接收不可变 ViewModel 和显式 callback。例如 `AssistantMessage` 不接触 `Channel`，而是接收 `{ rowId, revision, blocks, streaming, theme }`；`PromptEditor` 不调用 `channel.submit`，只发出 `EditorCommand`。overlay 必须保留现有 pi-tui 的 `minWidth`、显式 row/col、margin、visible/hidden、nested focus restore 和关闭回调语义；若某项在 v2 降级，必须在能力矩阵中登记。

### 5.2 Event/model contract

下列辅助类型属于 v2 schema，示例为便于审阅合并展示；实现必须按边界拆分为 `model/schema.ts`/`model/events.ts`、`renderer/frame.ts` 和 `terminal/writer.ts`，跨文件类型使用显式 `import type`，不得产生 runtime 循环。`model/schema.ts`/`model/events.ts` 必须有 JSON round-trip 测试；示例中的 `unknown` 不能在实现中退化成不可序列化对象：

```ts
export type SerializablePrimitive = string | number | boolean | null
export type SerializableValue = SerializablePrimitive | readonly SerializableValue[] | { readonly [key: string]: SerializableValue }
export type DeepReadonly<T> = T extends SerializablePrimitive ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type ResetReason = 'new-session' | 'resume' | 'rewind' | 'clear' | 'snapshot-gap' | 'adapter-reconnect'
export type EventSource = 'session' | 'stream' | 'input' | 'terminal' | 'overlay' | 'app' | 'plugin'
export interface EventMeta {
  readonly schemaVersion: 1
  readonly adapterInstanceId: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly resetEpoch: number
  readonly sessionEpoch: string
  readonly source: EventSource
  /** Monotonic within source, or a durable source event id. */
  readonly sourceSeq: string
  /** Adapter order; never inferred from `at`. */
  readonly seq: number
  readonly causalSeq?: number
  readonly at: number
}
export type InputCommand =
  | { readonly type: 'editor'; readonly command: 'insert' | 'delete' | 'move' | 'submit' | 'cancel'; readonly text?: string }
  | { readonly type: 'scroll'; readonly delta: number }
  | { readonly type: 'overlay'; readonly command: 'open' | 'close' | 'focus'; readonly overlayId?: string }
  | { readonly type: 'app'; readonly command: 'interrupt' | 'exit' | 'redraw' }
export type OverlayAnchor = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center' | 'left-center' | 'right-center'
export interface UiRowSnapshot {
  readonly rowId: string
  readonly durableRowId?: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly sessionEpoch: string
  readonly source: 'session' | 'local' | 'notice' | 'activity' | 'plugin'
  readonly sourceId: string
  /** Stable source/durable event identity used to derive `rowId`. */
  readonly sourceSeq: string
  readonly durableEventId?: string
  readonly revision: number
  readonly kind: string
  readonly blocks: readonly SerializableValue[]
  readonly settled: boolean
  readonly tool?: ToolLifecycleSnapshot
}
export interface ToolLifecycleSnapshot {
  readonly phase: 'running' | 'result' | 'error'
  readonly lifecycleRevision: number
  readonly durationMs?: number
  readonly callView?: SerializableValue
  readonly resultView?: SerializableValue
  readonly error?: SerializableError
}
export interface OverlayState {
  readonly overlayId: string
  readonly revision: number
  readonly anchor: OverlayAnchor
  readonly minWidth?: number | `${number}%`
  readonly width?: number | `${number}%`
  readonly maxHeight?: number | `${number}%`
  readonly row?: number | `${number}%`
  readonly col?: number | `${number}%`
  readonly margin?: { readonly top?: number; readonly right?: number; readonly bottom?: number; readonly left?: number } | number
  readonly offsetX?: number
  readonly offsetY?: number
  readonly visible: boolean
  readonly captureInput: boolean
  readonly nonCapturing: boolean
  readonly payload: SerializableValue
}
export interface SceneViewModel { readonly sceneId: string; readonly revision: number; readonly data: SerializableValue }
export interface SerializableError { readonly code: string; readonly message: string; readonly recoverable: boolean; readonly details?: SerializableValue }
export interface FrameLayer { readonly id: string; readonly z: number; readonly revision: number; readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } }
export interface UiSnapshot {
  readonly schemaVersion: 1
  readonly adapterInstanceId: string
  readonly durableSessionId: string
  readonly uiSessionGeneration: string
  readonly resetEpoch: number
  readonly sessionEpoch: string
  readonly revision: number
  readonly rows: readonly UiRowSnapshot[]
  readonly snapshotHash: string
  readonly status: SerializableValue
}

export interface Clock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}
export interface RandomSource { next(): number }
```

`Clock` 的 timer handle 是进程内实现细节，禁止进入 `AppEvent`/trace；所有会进入 schema、snapshot 或 fixture 的值仍必须属于 `SerializableValue`。

`UiRowSnapshot`、`OverlayState`、`UiSnapshot`、`Frame`、`TerminalCell`、resources 和 mode snapshot 都是发布后的 immutable data：实现边界使用 `DeepReadonly<T>` 做类型检查，并在 adapter/reducer/frame builder 输出时 deep-copy 或 `Object.freeze`（含嵌套数组/对象）；任何 reducer/controller 都只能构造新对象，不能通过类型断言原位修改。测试必须尝试修改已发布 snapshot/frame 并断言失败或不会影响后续 canonical state。

`durableSessionId` 是 session log 的可复用业务身份；`uiSessionGeneration` 是每次 adapter 启动/跨进程 resume 生成且永不复用的 UI 身份。`sessionEpoch` 固定为 `<uiSessionGeneration>:<resetEpoch>`，因此跨进程 resume 即使读取同一 durable session，也不会复用 row/cache/selection identity。`rowId` 是 UI identity；若需要跨进程语义关联，另用 `durableRowId`，不能把它当作 UI cache key。优先使用 session durable event id；没有 durable id 的 session row 使用该 epoch 内的 `sourceSeq`，local/notice/activity/plugin row 使用 `source + sourceId + sessionEpoch + local counter`。reset epoch 改变时所有旧 selection、height/cache、overlay anchor 和 pending row 引用失效；跨 epoch 不允许仅凭 `rowId` 命中缓存。`sourceId`、`sourceSeq`、`revision` 和 `settled` 的生命周期必须在 fixture 中固定，running row 只能追加 revision，不得原位改写已发布 snapshot。

```ts
export type AppEvent =
  | (EventMeta & { type: 'session/row-upsert'; row: UiRowSnapshot })
  | (EventMeta & { type: 'session/row-complete'; rowId: string; revision: number })
  | (EventMeta & { type: 'session/rows-reset'; resetId: string; rows: readonly UiRowSnapshot[]; snapshotHash: string; revision: number; ready: true; reason: ResetReason })
  | (EventMeta & { type: 'stream/chunk'; rowId: string; text: string })
  | (EventMeta & { type: 'stream/settled'; rowId: string; revision: number })
  | (EventMeta & { type: 'input/command'; command: InputCommand })
  | (EventMeta & { type: 'viewport/resize'; width: number; height: number })
  | (EventMeta & { type: 'overlay/open'; overlay: OverlayState })
  | (EventMeta & { type: 'overlay/close'; overlayId: string })
  | (EventMeta & { type: 'terminal/suspended' | 'terminal/resumed' })
  | (EventMeta & { type: 'app/error'; error: SerializableError })
```

`AppEvent` 必须可 JSONL 序列化。`adapterInstanceId + seq` 是全局事件身份，`source + sourceSeq` 是来源身份，`causalSeq` 只用于诊断因果链；reducer 对已处理序号去重，对缺口、乱序和重复事件记录诊断并按明确的 `reset` 规则处理，不能用 `at` 排序。`rows-reset` 是原子初始化完成事件：`ready: true`、`resetId`、`snapshotHash`、`revision` 和每个 row 的 `sessionEpoch` 必须一致，校验通过后才替换 rows、清空旧引用并允许新 epoch 的 stream/input 事件；校验失败进入 error/cleanup，不得静默接受部分 rows。旧 epoch 的业务事件一律丢弃（只保留有限诊断）。跨进程 resume 必须以新的 `adapterInstanceId + uiSessionGeneration` 加 durable session id 重新建立顺序，不能沿用旧 `seq`。`at` 只用于诊断，canonical state 比较时忽略它。事件中不得包含 credential、完整 prompt、工具 secret 或不可控对象引用；trace writer 在边界处脱敏。
ingress 处将 `AppEvent` 按 schema validate 后 deep-copy/freeze；reducer 只能消费 `DeepReadonly<AppEvent>`，不能由 listener 原位改写 event 或其 row/overlay payload。

顺序处理是确定性的：`seq <= lastAppliedSeq` 的重复/迟到事件丢弃并计数；`seq === lastAppliedSeq + 1` 立即应用；更大的 seq 只能进入上限 64 条或 150 ms 的 gap buffer，缺口在任一上限达到时触发 `snapshot-gap` reset 并丢弃 buffer。reset 之后旧 `sessionEpoch` 的 buffer 全部失效；同一 `sourceSeq` 的不同 payload 记录冲突并阻断 fixture，不能以到达时间猜测胜者。

live/replay 的等价定义是 `serializeCanonicalUiState(state)` 的字节等价：删除时钟、诊断计数、对象 identity 和随机 trace id，只保留 session row id/revision、focus、viewport、overlay、terminal generation、pending command 的稳定字段。replay 必须覆盖重复、乱序、seq 缺口、rows-reset、resume/rewind 和取消中的事件；副作用只由 controller 重新执行，不能在 reducer 中偷偷补发。

动画 tick、spinner、超时和随机选择都通过注入的 `Clock`/`RandomSource` 进入 event trace；renderer/reducer 禁止直接读取 `Date.now()`、`Math.random()` 或真实 timer。live 模式可以使用真实实现，replay/benchmark 使用 deterministic source，以便同一 trace 的 frame 与 canonical state 可重放。

`UiState` 至少包含：

- `session`: durable session id、ui session generation、rows 的有序引用、当前 streaming row、折叠/加载更早行的游标和 reset readiness。
- `focus`: 当前焦点目标、编辑器状态、捕获输入的 overlay。
- `viewport`: width、height、scrollTop、maxScroll、sticky、unseen count。
- `dock`: editor、status、activity、pending messages、notifications。
- `overlays`: 有序 stack、anchor、capture、revision。
- `terminal`: mode、profile、generation、needsFullRedraw。
- `preferences`: theme、language、diff layout、activity 等 UI 偏好。
- `diagnostics`: 有界计数器和最近一次错误摘要，不保留无限 trace。

### 5.3 Row identity/revision

```ts
export type RowCacheKey = {
  durableSessionId: string
  uiSessionGeneration: string
  sessionEpoch: string
  rowId: string
  revision: number
  width: number
  themeId: string
  terminalProfileId: string
}
```

- canonical `sessionEpoch` 是 adapter 生成的不可变字符串 `<uiSessionGeneration>:<resetEpoch>`；`durableSessionId` 只用于业务关联，不进入可跨进程复用的 UI identity；`rowId` 为 `sessionEpoch:sourceKind:sourceId:sourceSeq`。有业务 durable id 时另存 `durableRowId`，没有 durable id 的 session row 使用该 epoch 内的 source sequence，没有 seq 的 local/notice/activity/plugin 行使用 reset epoch 内按 `sourceId` 分区、由 adapter 分配且持久到该行 settled 的 ordinal，不能用数组索引、当前文本或会重置的 `ChatRow.id`。nested tool rows 继承父 identity 并追加稳定 child key。
- `rowId` 的各段使用 canonical length-prefix/escape 编码后拼接，禁止直接拼接可能含分隔符的外部 id；同一 `(sessionEpoch, source, sourceId, sourceSeq)` 必须得到同一字节串。
- `sessionEpoch` 变化即使数字 row id 重复也视为新身份；reset 时必须使旧 cache/viewport anchor 失效。
- streaming 中只有当前 row 的 revision 变化；完成后 revision 固定。
- tool row 的 `running -> result/error` 也只能发布新 `revision` 和新的 `ToolLifecycleSnapshot`；`durationMs`、`callView`、`resultView` 不得在已发布 snapshot 上原位修改。`lifecycleRevision` 只在 tool 生命周期变化时递增，普通 spinner/通知不能使完成 row 失效。
- width、theme、profile 任一变化都使渲染缓存失效，但不改变业务 row revision。
- cache 必须区分 `streaming` 和 `settled`；长流式尾部不可依赖父字符串切片保活。

### 5.4 TerminalProfile

```ts
export type Capability = 'yes' | 'no' | 'unknown'
export type ImageProtocol = 'kitty' | 'iterm2' | null

export interface TerminalProfile {
  id: string
  family: 'kitty' | 'iterm2' | 'windows-terminal' | 'conpty' | 'conhost' | 'jetbrains' | 'zed' | 'vscode' | 'unknown'
  term: string
  colorTerm?: string
  locale?: string
  columns: number
  rows: number
  ambiguousWidth: 1 | 2 | 'unknown'
  unicodeLevel: number | 'unknown'
  supportsSyncOutput: Capability
  supportsKittyKeyboard: Capability
  supportsBracketedPaste: Capability
  supportsFocusReporting: Capability
  supportsModifyOtherKeys: Capability
  supportsWindowsDec9001: Capability
  supportsOsc8Hyperlinks: Capability
  supportsOsc52: Capability
  supportsOsc133: Capability
  supportsTabTitle: Capability
  supportsOsc11: Capability
  supportsXtvVersion: Capability
  supportsCellSizeQuery: Capability
  supportsProgress: Capability
  supportsTrueColor: Capability
  supportsMouse: Capability
  supportsAlternateScreen: Capability
  imageProtocol: ImageProtocol | 'unknown'
  multiplexer: 'none' | 'tmux' | 'screen' | 'zellij' | 'unknown'
  platform: NodeJS.Platform
}
```

`Capability` 为 `'yes' | 'no' | 'unknown'`。能力探测必须有超时、缓存和 unknown 分支。不能因为一个查询未返回就永久阻塞启动；unknown 时关闭高级协议并使用保守重绘，宽度管线必须消费 profile 的 ambiguousWidth，不能固定为 narrow。

最终实现固定探测参数：单次查询超时 150 ms，最多 1 次重试；启动总等待不超过 300 ms，超时即 `unknown-conservative`。profile cache 只在进程内存活，resize 不重新探测能力；终端接管结束或 profile id 变化时清空。每个 profile fixture 必须记录 `TERM`、`COLORTERM`、`TMUX`、平台、尺寸、ambiguous width、查询响应和最终 capability；迟到响应不得回写已提交的 profile generation。

`unknown-conservative` 的确定性默认值是 `ambiguousWidth: 1`、`unicodeLevel: 'unknown'`、所有高级 capability 为 `unknown`，renderer 关闭 sync output/Kitty/OSC52/mouse/images 并选择 full redraw；`supportsAlternateScreen !== 'yes'` 时强制走 inline/非交互降级，不得进入 `TuiAltScreen`；若产品场景明确要求 fullscreen，则启动前返回 `unsupported-alternate-screen` 并保持终端未接管。不得把 unknown 当作支持。自动化 profile 必须在 fixture 中显式覆盖这些字段，真实探测只允许更新当前 profile generation；`unknown-conservative` 必须有“拒绝 alt screen、仍可输入/退出、无模式泄漏”的 fixture。

### 5.5 Frame/Cell contract

```ts
export interface TerminalCell {
  readonly grapheme: string
  readonly width: 0 | 1 | 2
  readonly styleId: number
  readonly hyperlinkId?: number
}

export interface StyleDescriptor {
  readonly id: number
  readonly foreground: string | null
  readonly background: string | null
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
  readonly strike: boolean
}
export interface HyperlinkDescriptor { readonly id: number; readonly uri: string; readonly params?: string }
export interface FrameResources {
  readonly styles: readonly StyleDescriptor[]
  readonly hyperlinks: readonly HyperlinkDescriptor[]
}
export interface TerminalModeSnapshot {
  readonly alternateScreen: boolean
  readonly rawInput: boolean
  readonly mouse: MouseTrackingMode
  readonly bracketedPaste: boolean
  readonly syncOutput: boolean
  readonly autowrap: boolean
  readonly wrapPending: boolean
  readonly scrollRegion: { readonly top: number; readonly bottom: number }
  readonly cursorStyle: 'block' | 'underline' | 'bar' | 'unknown'
  readonly cursorVisible: boolean
  readonly kittyKeyboard: boolean
  readonly modifyOtherKeys: boolean
  readonly focusReporting: boolean
  readonly windowsDec9001: boolean
  readonly osc133: boolean
  readonly title: string | null
  readonly progress: { readonly state: 'none' | 'normal' | 'error' | 'paused'; readonly value?: number }
}

export type MouseTrackingMode = 'off' | 'x10-1000' | 'normal-1002' | 'button-1002' | 'any-1003' | 'sgr-1006' | 'urxvt-1015'

export interface Frame {
  readonly frameId: string
  readonly stateRevision: number
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly cells: readonly TerminalCell[]
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean }
  readonly modes: TerminalModeSnapshot
  readonly resources: FrameResources
  readonly images: readonly FrameImagePlacement[]
  readonly layers: readonly FrameLayer[]
  readonly generation: number
  readonly fullRedraw: boolean
  readonly metadata: FrameMetadata
}

export interface FrameMetadata {
  readonly changedRows: number
  readonly renderMs: number
  readonly diffMs: number
  readonly terminalProfileId: string
  readonly fullRedrawReason?: 'initial' | 'resize' | 'resume' | 'damage' | 'unknown-mode' | 'cleanup'
}

export interface ScreenBackendCapabilities {
  supportsViewportLayout: boolean
  supportsNestedOverlay: boolean
  supportsScrollRegion: boolean
  supportsInlineLiveRegion: boolean
}
export interface ScreenBackend {
  mode: 'fullscreen' | 'inline'
  capabilities: ScreenBackendCapabilities
  start(generation: number): Promise<void>
  plan(previous: Frame | null, next: Frame): TerminalPatch
  stop(generation: number): Promise<void>
}

export interface FrameImagePlacement {
  readonly imageId: string
  readonly protocol: 'kitty' | 'iterm2'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly payloadHash: string
  readonly storeKey: string
}

export interface ImageStore {
  put(payloadHash: string, bytes: Uint8Array, protocol: 'kitty' | 'iterm2'): Promise<{ storeKey: string; bytes: number }>
  get(storeKey: string): Promise<Uint8Array | null>
  release(storeKey: string): void
  clearGeneration(generation: number): void
  stats(): { entries: number; bytes: number; maxBytes: number }
}

export type PatchOperation =
  | { kind: 'write-cells'; x: number; y: number; cells: readonly TerminalCell[] }
  | { kind: 'erase'; x: number; y: number; width: number; height: number }
  | { kind: 'scroll'; top: number; bottom: number; delta: number }
  | { kind: 'cursor'; x: number; y: number; visible: boolean }
  | { kind: 'mode'; name: keyof TerminalModeSnapshot; value: null | boolean | number | string | TerminalModeSnapshot['scrollRegion'] | TerminalModeSnapshot['progress'] }
  | { kind: 'resources'; resources: FrameResources }
  | { kind: 'image-upload'; storeKey: string; protocol: 'kitty' | 'iterm2'; payloadHash: string }
  | { kind: 'image-place'; placement: FrameImagePlacement }
  | { kind: 'image-delete'; storeKey: string }
  | { kind: 'image-clear' }
export interface TerminalPatch {
  readonly frameId: string
  readonly stateRevision: number
  readonly patchSeq: number
  readonly generation: number
  readonly operations: readonly PatchOperation[]
  readonly bytes: number
  readonly fullRedraw: boolean
}
```

`stride === width`，`cells` 是 row-major 的 `width * height` 个 cell；宽字符的首 cell 为 `width: 2`，紧随其后的 continuation cell 为 `width: 0` 且 `grapheme: ''`，任何 patch 都不得只更新 continuation cell。空白 cell 必须显式带 style，`x/y` 必须落在 frame 内或是隐藏 cursor 的 `0,0`。`styleId`/`hyperlinkId` 只在 frame 内有效，且分别匹配 `StyleDescriptor.id`/`HyperlinkDescriptor.id`；`FrameResources` 必须在每个 frame 提供完整、id 唯一且可按 id 查找的 style/hyperlink 定义，不能把数组位置冒充稳定 id；patch 的 `resources` operation 在写 cell 前提交，writer 用固定 SGR/OSC 8 encoder 计算 bytes，不能跨 frame 借用已淘汰的 id。`modes` 是提交 frame 时的完整终端模式快照，virtual terminal 必须逐帧比较；title/progress/keyboard/focus 等不显示在 cell grid 中的状态也必须在 mode snapshot 中比较或明确标为 lifecycle-only。image payload 只以 hash 进入 trace，实际 bytes 由受控 image store 管理并有容量上限。

`ImageStore` 的实现必须有默认 32 MiB、最多 128 entries 的容量，按 generation 引用计数；`image-upload` 先校验 storeKey/hash/协议，再由唯一 writer 编码 Kitty APC 或 iTerm2 OSC 1337 bytes，`image-place` 只引用已上传 storeKey，`image-delete`/`image-clear` 在 resize、stop、generation 失效和 eviction 时释放。若 profile 为 `null`/`unknown` 或 image store 超预算，renderer 输出占位符并记录 `unsupported-image`，不得把未上传 payload 伪装为通过 golden。

`TerminalModeSnapshot.mouse` 不是简单开关：parser/virtual terminal 必须把 DECSET 1000/1002/1003 与 encoding 1006/1015 归一化为 `MouseTrackingMode`，保留互斥/组合规则；cleanup 只有在快照为 `off` 时才算恢复。每种 tracking mode、切换顺序、部分序列和异常 stop 都要进入 conformance fixture，不能把 1003/1006 的残留压成 `true` 后误判通过。

`renderer/frame.ts` 导出 `TerminalCell`、`Frame`、`FrameImagePlacement`、`PatchOperation` 和 `TerminalPatch`；`terminal/writer.ts` 只通过 `import type` 引用 `TerminalPatch`/`SerializableValue`，不会让 model 依赖 terminal。

逻辑行可以保留 ANSI 字符串以复用 pi-tui 的组件生态，但在 compositor/diff 前必须经过同一套 ANSI tokenizer、grapheme segmentation、width profile 和 cell 边界校验。所有物理行最后执行 `assertLineWidth <= viewport.width`；遇到无法安全放置的单个宽 grapheme 必须采用 profile 定义的替代 cell 或裁剪，不得抛到用户路径。

### 5.6 TerminalWriter, query and pi facade contract

```ts
export type ControlSequence = string & { readonly __terminalControlSequence: unique symbol }
export type TerminalLifecycleOperation =
  | { kind: 'lifecycle'; action: 'enter-raw' | 'exit-raw' | 'enter-alt' | 'exit-alt' | 'mouse' | 'paste' | 'focus' | 'sync-output' | 'cursor'; enabled: boolean }
  | { kind: 'cursor-move'; delta: number }
  | { kind: 'clear'; scope: 'line' | 'from-cursor' | 'screen' }
  | { kind: 'title'; value: string }
  | { kind: 'progress'; state: 'none' | 'normal' | 'error' | 'paused'; value?: number }
export type TerminalControlOperation =
  | { kind: 'lifecycle'; operation: TerminalLifecycleOperation }
  | { kind: 'sequence'; sequence: ControlSequence; purpose: 'pi-compatible' | 'query-write' | 'cleanup' }
  | { kind: 'query'; request: QueryRequest; token: QueryToken }
export type QueryKind = 'cursor' | 'size' | 'cell-size' | 'version' | 'capability' | 'color' | 'kitty-keyboard' | 'focus'
export interface TerminalInputEvent {
  kind: 'key' | 'paste' | 'mouse' | 'focus' | 'resize' | 'signal' | 'query-response'
  sequence: number
  generation: number
  payload: SerializableValue
  query?: { tokenId: string; kind: QueryKind; value: SerializableValue }
}
export type QueryResponse = { tokenId: string; generation: number; kind: QueryKind; value: SerializableValue; receivedAt: number }
export interface QueryRequest { kind: QueryKind; generation: number; timeoutMs: number; retry: number; expected: 'cursor-report' | 'size-report' | 'cell-size-report' | 'version-report' | 'capability-report' | 'color-report' | 'kitty-keyboard-report' | 'focus-report' }
export interface QueryToken {
  readonly id: string
  readonly generation: number
  readonly kind: QueryKind
  readonly __opaqueQueryToken: unique symbol
}
export interface QueryBroker {
  request(request: QueryRequest): Promise<QueryResponse>
  accept(token: QueryToken, input: TerminalInputEvent): boolean
  cancel(token: QueryToken): void
  isRegistered(token: QueryToken): boolean
}
export interface WriterError { code: string; message: string; generation: number; recoverable: boolean; details?: SerializableValue }
export type WriteResult =
  | { status: 'written' | 'stale' | 'stopped'; bytes?: number; frameId?: string; stateRevision?: number; patchSeq?: number }
  | { status: 'error'; error: WriterError }
export interface WriterBarrier { generation: number; committedPatchSeq: number }

export interface TerminalWriter {
  write(patch: TerminalPatch): Promise<WriteResult>
  writeControl(operation: TerminalControlOperation, generation: number): Promise<WriteResult>
  query(request: QueryRequest): Promise<QueryResponse>
  quiesce(): Promise<WriterBarrier>
  resume(barrier: WriterBarrier, generation: number): void
  flush(): Promise<void>
  invalidate(): void
  stop(options?: { preserveScreen?: boolean }): Promise<void>
}

/** Exact synchronous facade required by the pinned pi-tui Terminal interface. */
export interface PiTerminalAdapter {
  start(onInput: (data: string) => void, onResize: () => void): void
  stop(): void
  awaitStop(): Promise<void>
  drainInput(maxMs?: number, idleMs?: number): Promise<void>
  write(data: string): void
  readonly columns: number
  readonly rows: number
  readonly kittyProtocolActive: boolean
  moveBy(lines: number): void
  hideCursor(): void
  showCursor(): void
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void
  setTitle(title: string): void
  setProgress(active: boolean): void
}
```

writer 必须：

- 只接受由 `DiffPlanner` 产生并通过 schema 校验的 `TerminalPatch`；`generation` 不匹配时返回 `{ status: 'stale' }`，绝不写 stdout。
- 合并为有限大小的 buffered write，尊重 `stdout.write()` 的 callback/backpressure；`write()` 只能在前一个 write settle 后推进，partial/error 必须转成可观察的 `WriterError`。
- 维护 write generation，旧 frame 在 resize/stop 后不能继续输出；stop 先阻止新 patch，再等待当前 write 或按超时销毁。
- 不接受任意模块传入的原始未清洗 ANSI；控制序列只能由 `terminal/ansi.ts` 生成。
- terminal query、raw/alt/mouse/paste/lifecycle cleanup 也必须转换成 `writeControl` operation 进入同一队列；query subsystem 只读 stdin response，不得自行 `stdout.write`。
- 记录有限的 bytes/frame/time 统计，不保存完整 stdout。`stdout.write` 的直接调用只存在于 writer 实现和受测试的 `VirtualTerminal`。

`PatchOperation`/`TerminalLifecycleOperation`/`TerminalControlOperation`/`QueryRequest` 是内部的可判别 schema，不是开放的 `SerializableValue`；实现必须在 enqueue 前校验坐标、cell continuation、资源引用、控制参数和 `bytes`。只有 `terminal/ansi.ts` 的受限 builder 能生成 branded `ControlSequence`，builder 还必须在运行时按 allowlist 校验 action、参数范围和 OSC payload；调用方不能传入任意 CSI/OSC string。`QueryBroker` 在自己的模块内生成 `Object.freeze` 的 branded `QueryToken`，并用 `WeakSet`/identity map 登记活跃 token；token 没有公开 constructor，只有 broker 能创建/注销，复制同样字段的对象也不通过 `isRegistered`。stdin owner 只把 `kind: 'query-response'` 且同时匹配 token identity、id、generation、QueryKind 和 grammar 的解析结果交给 broker，迟到、重复、同代错配响应丢弃并计数。响应 waiter 的身份是 token，不得以 query kind 或 writer slot 作为关联键。

query 的发送和等待解耦：查询字节可短暂占用 writer 的一个 bounded write slot，但 response waiter 不占 slot，也不阻塞 frame/input；只有 `TerminalWriter.query()` 能从 broker 取得已登记 token 并生成 query `TerminalControlOperation`，公开的 `writeControl` 收到 query 分支时必须再次调用 `isRegistered`，并同时校验 token.generation、request.generation、operation generation 三者一致、token 未取消且 request 未重复；任何未登记/错代/重复 query 直接返回 `stale`/`WriterError`，不得发送。每个 query write 最多等待 20 ms，响应 deadline 150 ms、最多 1 次重试，总计不超过 300 ms。运行期 query 失败只产生 `unknown` profile event；只有 startup capability transaction 可以暂停 render，且暂停上限 300 ms。必须有 `query-under-stream`、同类并发 query、伪造 token、late response 和 backpressure fixture。

writer 对 patch 维护 `(generation, stateRevision, patchSeq)` 提交水位：generation 较旧、stateRevision 小于已提交值，或 patchSeq 非递增的 patch 返回 `stale`；partial write 只有在整个 patch 完成后才推进水位，stop/quiesce 会阻止新 patch 并等待当前 patch settle。`quiesce()` 返回 barrier 后才允许 ScreenTakeover 转移 tty。

`TerminalWriter` 与 pi 的同步 `Terminal.write(string): void` 是适配关系，不是同一 API：vendored terminal 的 `Terminal.write` 只被 `PiTerminalAdapter` 调用，由 adapter 把同步字符串转换成带当前 `generation` 的 `TerminalPatch`/`writeControl`，不会直接触碰 Node `stdout`；dsh writer 负责 Node stream backpressure、generation 和错误。任何 `write`、`flush`、`stop` 的拒绝都必须进入 coordinator 的生命周期状态机。

pi 的同步 `Tui.stop()` 只能发出 stop request；fork 的 coordinator 必须在任何 `process.exit`/launcher return 前执行 `await adapter.awaitStop()`。该 barrier 依次等待 `TerminalWriter.stop()`、当前 write settle 或明确 timeout、cleanup control sequence flush、stdin `drainInput()` 和 signal listener removal；成功或超时都写入一次 lifecycle artifact，超时使用专用非零退出码。这样 pi 的同步 facade 不会让进程在 raw/alternate/mouse/paste cleanup 尚未提交时提前终止。

pi facade 的实施选择固定为“**保留完整 facade，同时 fork 所有生产调用点**”：`PiTerminalAdapter` 必须逐项满足 pinned pi `Terminal` 的 `start/stop/drainInput/columns/rows/kittyProtocolActive/moveBy/hideCursor/showCursor/clearLine/clearFromCursor/clearScreen/setTitle/setProgress` 签名，并提供额外的 `awaitStop()`；其同步方法只把 typed operation 入队，`stop()` 的异步错误通过 lifecycle error channel 回传，调用方不能把返回值当作已完成。fork 中的 `Tui`、`tui-alt-screen`、`tui-main-screen` 不得再构造任意 ANSI 字符串后调用 `write`：这些调用点改用 `PatchSink`/`TerminalControlOperation` builder；`PiTerminalAdapter.write(string)` 仅作为兼容边界，接受由 fork `PiOutputEncoder` 生成的字符串，并由 `parsePiTerminalString` 严格解析以下集合：普通可打印文本和受控换行、SGR、光标相对移动、擦除、scroll、OSC 8、标题、进度、已声明的 Kitty/iTerm2 image marker，以及已登记的 query sequence。解析结果只能生成 cell/control/image/query operation；未知 CSI/DEC/OSC、未登记的 APC、未闭合 OSC、超过 8 MiB 的单次 payload 或不能在当前 profile 证明安全的序列必须拒绝并产生 `unsupported-pi-sequence`，不能原样透传。用户/工具文本永远走 data encoder，不得复用该 parser。parser 必须有 compile smoke、每个 allowlisted sequence 的 round-trip fixture、未知序列拒绝 fixture、partial-string 重组 fixture 和 backpressure/error fixture；任何 fork 新增 terminal call site 必须更新 adapter method matrix 和 patch ledger。

### 5.7 RenderScheduler contract

优先级从高到低：`exit/error`、用户输入、resize/terminal lifecycle、同步状态、streaming chunk、低优先级通知。

调度规则：

1. 同一时刻最多一个 `render()` 和一个 writer operation（`write` 或 `writeControl`）。
2. stream chunk 在 16--33 ms 窗口内合并；窗口内只保留最新可渲染 state，不排队数百个 frame。
3. 输入和 Ctrl+C 立即打断低优先级 pending render，但不打断正在写入的 ANSI patch。
4. resize 开启 transaction：更新尺寸/profile、清除宽度/布局缓存、强制全量合成、提交一个 frame。
5. 新 frame 的 `stateRevision` 小于 writer 已提交 revision 时直接丢弃。
6. 关闭/异常进入 stop 状态后，所有后续 render request 都被拒绝并释放 timer。

调度和终端生命周期共享以下有限状态机：`created -> starting -> active -> stopping -> stopped`，另有终态 `failed-before-takeover`、`failed-after-takeover`。初始化失败无论是否已接管终端，都只能执行 cleanup、写诊断并以专用退出码结束；禁止同进程启动第二套 renderer 或 fallback。外部 launcher 可以按 rollback manifest 重新拉起上一发布包。`stop`、signal、writer error、cleanup error 都是幂等转换；状态、owner 和 `generation` 写入 trace，测试必须覆盖重复 signal、late write、stop 与 resize 竞态。

生命周期时限固定为：单个 writer operation 等待 500 ms 后转为 `WriterError`，coordinator cleanup 总 deadline 为 2 s；deadline 到期仍需 best-effort 发送退出序列、关闭 stdin/listener 并以专用非零退出码结束，不能无限等待或继续接收新输入。真实终端和 child-process fixture 都记录每个 deadline 的命中情况。

---

## 6. 渲染与终端实现方案

### 6.1 统一宽度管线

所有需要测量、换行、截断或定位的文本必须按以下顺序处理：

```text
raw string
  -> ANSI/OSC tokenization
  -> grapheme segmentation
  -> TerminalProfile width calculation
  -> cell sequence
  -> wrap/truncate/clip
  -> styled line/cell output
```

禁止以下实现：

- `string.length` 作为终端列数。
- 组件直接调用不同版本的 `string-width`。
- Markdown、editor、diff、status 各自实现换行。
- 先按 Unicode 宽度换行，最后让 terminal backend 再解释。
- `width <= 0` 时直接 `repeat(width)` 或递归拆分。

必须覆盖：ASCII、CJK、全角标点、ambiguous width、组合字符、ZWJ emoji、regional indicator、variation selector、控制符、ANSI style、OSC 8 hyperlink、tab、RTL 文本和超宽单 grapheme。

实现参数必须固定并写入 `TerminalProfile`/fixture：grapheme 首选 `Intl.Segmenter('und', { granularity: 'grapheme' })`（运行时不支持时使用 vendored fallback）；East Asian Width 使用 pinned `get-east-asian-width` 版本，`ambiguousWidth` 来自 profile；tabstop 固定为 3 且按当前列展开；C0/控制符宽度为 0 并按清洗策略处理；ZWJ/regional-indicator/variation selector 以完整 grapheme 测量；RTL 只保证逻辑顺序和宽度，不在 v2 伪造 bidi shaping。每个 width/profile 变化都必须重新生成 cell sequence，不能共享错误 profile 的缓存。

组件生成的 ANSI 只能来自受信任的 style/terminal builder；用户 prompt、工具输出、插件文本和 child output 先作为纯文本 escape/strip，再由组件重新着色。禁止把不受信任文本直接拼进 CSI、OSC 8/52、标题、同步输出或图片序列；这条边界由 fuzz 和 byte-level terminal-state assertion 覆盖。

### 6.2 Base renderer

base renderer 只负责生成没有浮层覆盖的主内容：

```text
viewport
  ├─ transcript scroll region
  │   ├─ welcome/header
  │   ├─ visible settled rows
  │   ├─ current streaming row
  │   └─ unseen/new-message indicator
  └─ dock
      ├─ notifications/activity
      ├─ prompt editor
      └─ status/footer
```

必须保持 transcript 的虚拟化和 sticky scroll，但改为显式 `ViewportModel`，不依赖 Yoga 对整个树的隐式测量。实现采用 variable-height `HeightIndex`（row id/revision -> 行高、前缀和），只测量可见区加 overscan；初始 overscan 为 `max(2 * viewportHeight, 64)` 行，上限 600 行和 2,000,000 cells，超过上限通过 `loadOlder()`/分页而不是把完整 transcript 复制进 frame。settled row 的高度按 `(sessionEpoch, rowId, revision, width, theme, profile)` 缓存；width/profile 改变时以 transaction 清理或迁移。

scroll anchor 必须保存 `{ sessionEpoch, rowId, intraRowOffset }`：streaming 当前尾行增长时 follow-end 只移动尾部，用户离开底部后不得因新消息跳动；`loadOlder()` 在 prepend 后恢复 anchor，reset epoch、row eviction、resize 无法恢复 anchor 时退回明确的 top/bottom 策略并记录诊断。viewport 只持有有界 row view；session log/adapter 负责按 id 重新取回被窗口淘汰的内容。

### 6.3 Compositor/layer model

合成顺序固定为：

```text
baseFrame
  + overlay stack (back -> front)
  + selection/search highlight
  + cursor marker/hardware cursor metadata
  = finalFrame
```

每一层携带位置、裁剪区域、捕获策略和 layer revision。overlay 关闭时只需重新合成受影响区域；若无法证明局部 patch 安全，设置 `fullRedraw=true`，不能从 previous final frame blit。

浮层 contract 至少支持：center/edge anchor、绝对/百分比尺寸、边距、最大高度、非捕获层、焦点转移、嵌套和关闭回调。浮层下方永远来自本次 baseFrame。

### 6.4 Fullscreen backend

`TuiAltScreen` 负责：

- alternate screen 进入/退出。
- 固定 viewport 高度、transcript scroll、dock、鼠标和选区。
- 全量 frame 作为正确性参考。
- resize 时原子清屏/重绘，不写入主屏 scrollback。
- Ctrl+L、SIGCONT、未知终端状态时回退 full redraw。

fullscreen 的滚动、overlay、selection、search、copy 和 cursor 行为先达到验收标准，再把它作为默认交互模式。

pi-tui 的 `ViewportTUI`/`isViewportTUI` 语义是能力边界：只有 alt-screen/viewport backend 才能承诺固定布局根、sticky/nested viewport 和可靠的整屏重绘；main-screen 不得伪装提供这些 API。v2 backend contract 必须显式声明 `supportsViewportLayout`、`supportsNestedOverlay` 和 `supportsScrollRegion`，组件/selector 通过 capability 选择降级。

### 6.5 Inline/main-screen backend

`TuiMainScreen` 负责主屏 scrollback 兼容：

- 已完成 transcript 尽量 append-only。
- 只维护底部有限 live region。
- 不在历史 scrollback 任意放置可变 overlay。
- 不依赖复杂 DECSTBM 快速路径作为唯一正确性来源。
- resize、第三方 stdout 污染、物理光标不确定时允许保守重锚或 full redraw。
- 与 fullscreen 共享 ViewModel 和 component，不共享 cursor/scrollback patch 算法。
- main-screen 明确声明不支持固定 viewport layout、任意 nested viewport 或历史区域 overlay；收到这些请求时返回 `unsupported`/降级通知并保留 append-only 语义。

`DiffPlanner` 只负责把同一 backend contract 的 frame metadata 转成候选 patch；物理算法由 backend 所有：`TuiAltScreen` 可以按 cell/row 做 viewport diff，`TuiMainScreen` 负责 append-only、live-region 重锚和 scrollback 安全检查。backend 生成的 patch 必须带 `generation`、mode transition 和 `fullRedraw` 原因，再交给唯一 writer；禁止把 fullscreen 的 cursor/scrollback patch 直接复用到 main-screen。

inline 能力较少是明确产品选择，不通过隐藏分支伪装成与 fullscreen 完全等价。

### 6.6 输入与终端生命周期

所有 stdin 输入先进入 `terminal/input.ts`：

```text
stdin bytes
  -> buffered tokenizer
  -> escape/key/paste/mouse protocol
  -> InputEvent
  -> input controller
  -> reducer command / DSH side effect
```

`TerminalInputEvent` 是 tokenizer 的唯一结构化输出；普通输入至少包含 `{ kind: 'key' | 'paste' | 'mouse' | 'focus' | 'resize' | 'signal'; sequence: number; generation: number; payload: SerializableValue }`，query response 还必须包含 `{ kind: 'query-response'; query: { tokenId; kind; value } }`。`InputEvent` 只是 controller 层对 `TerminalInputEvent` 的不可变别名，不能再定义第二套 stdin schema。原始 bytes 只能留在受保护的短期诊断 ring，不能进入 `AppEvent` 或 transcript。`sequence` 在 stdin owner 内单调递增，generation 不匹配、token 不匹配或 grammar 校验失败的 late response 直接丢弃。

bootstrap 在接管前校验 `stdin.isTTY`、`stdout.isTTY` 和有效尺寸；非 TTY 只走明确的非交互错误/降级路径，不发送 raw/alt/鼠标/同步输出序列。VirtualTerminal/PTY 测试可以显式声明为测试终端，不能让生产路径默认为测试能力。

生命周期必须覆盖：启动、raw mode、bracketed paste、mouse、Kitty keyboard、focus report、resize、SIGWINCH、SIGCONT、SIGHUP、SIGINT、SIGTERM、stdin close、stdin drain、uncaught exception、unhandled rejection、Cordis teardown、用户 exit、emergency cleanup、正常 stop 和 update restart。cleanup 要幂等，并在重复 signal 下不写出破坏序列；user exit 不得误触发 service teardown 的二次提交，teardown 也不能绕过 `createExitFunnel`/`finishExit`/resume marker 约束。

`SessionBrowser`、`Settings`、`TrajectoryScene` 和 external editor/update 若暂时接管 alternate screen/TTY，必须通过 `ScreenTakeover` contract：`request(ownerKind, reason) -> TakeoverLease(token, barrier, modeSnapshot) -> suspend writer/input -> transfer tty -> restore(token) -> generation++/full redraw`。同一时刻只能有一个 lease；owner 异常、取消或 Cordis teardown 都走 token 校验后的 restore/cleanup，不能让场景自行调用 `process.stdout` 或遗留旧 Ink instance。

```ts
export interface TakeoverToken {
  readonly id: string
  readonly ownerKind: 'scene' | 'external-editor' | 'update' | 'shutdown'
  readonly generation: number
  readonly __opaqueTakeoverToken: unique symbol
}
export interface TakeoverLease {
  readonly token: TakeoverToken
  readonly generation: number
  readonly modeBeforeTakeover: TerminalModeSnapshot
  readonly barrier: WriterBarrier
}
export interface ScreenTakeover {
  request(ownerKind: TakeoverToken['ownerKind'], reason: string): Promise<TakeoverLease>
  restore(token: TakeoverToken, options?: { reason?: 'completed' | 'cancelled' | 'error' | 'teardown' }): Promise<void>
  current(): { token: TakeoverToken; generation: number } | null
}
```

`TakeoverToken` 只能由 coordinator 在 `request` 成功时签发，插件、scene 和外部 child 不能自行构造或仅凭字符串恢复。`request` 在已有 lease 时拒绝并保持原 owner；成功路径先停止接收新的 input event，调用 writer `quiesce()` 并等待 barrier（包括当前 partial write settle），保存完整 `TerminalModeSnapshot`，再暂停 raw/mouse/paste/focus/keyboard ownership 并把 stdin/stdout 明确转给 child。child 的输出只由其 lease 期间的 owner 使用，不能进入 v2 writer。`restore` 必须以同一个 opaque token 校验 generation 和 lease id，恢复保存的 mode snapshot、重新获得 stdin、generation 递增、清空旧 frame/image generation 并提交一次 `fullRedraw`；重复 restore 同一 token 是幂等成功，错误 token 只能进入 cleanup/error，不得释放别人的 tty。request、child spawn、child exit、restore、restore timeout、SIGINT 和 teardown 都必须有 fixture，记录 barrier、stdin owner、mode snapshot、generation 和是否写过 stdout。

### 6.7 外部输出与日志

活动 TUI 期间，不能把所有 child output 粗暴地当作可清洗文本；先声明 tty ownership：

| 来源 | owner | v2 行为 |
| --- | --- | --- |
| DSH tool stdout/stderr | DSH adapter/controller | 按工具事件/受控 transcript 投影；ANSI 作为数据清洗，不直接写 stdout |
| debug logger | diagnostics logger | 只写受控 stderr/diagnostic file，限流和脱敏 |
| external editor、update、screen takeover | lifecycle coordinator 或 child process | 暂停 writer、恢复 stdin/terminal modes、child 完成后 generation++ 和一次 full redraw；child 可暂时拥有 tty，不把其原始 output 混入 frame |
| plugin/update 直接输出 | plugin host/lifecycle | 默认拒绝/重定向；allowlist 中的 output 必须带 owner 和 cleanup |
| terminal query response | terminal input/query subsystem | 只消费匹配 generation 的响应，不进入 transcript 或回显 |

活动 TUI 期间还必须满足：

- 工具 stdout/stderr 先经过 ANSI 清洗和事件转换，再进入 transcript/component。
- debug 只走受控 stderr logger，并有环境开关和限流。
- 禁止 `console.log`、`console.warn` 或业务模块的 `process.stdout.write` 穿透当前 frame。
- clipboard、update、external editor 等需要短暂离开 TUI 的流程必须通过 lifecycle coordinator 挂起、恢复并触发一次 full redraw。

本次实现产出 `docs/tui-v2-stdout-ownership.md`，并以扫描结果冻结下表；每个条目都要有 owner、backpressure 规则、cleanup 责任和允许的生命周期。`stderr` 也要区分正常 logger、child passthrough 和 teardown restore，不能以“不是 stdout”跳过 cleanup。

| 当前路径/来源 | 当前写入形态 | v2 owner 与边界 | 一次性迁移与验收要求 |
| --- | --- | --- | --- |
| `src/ink/ink.tsx`、`src/ink/components/App.tsx` | 旧 render/cleanup 直接进入 terminal | `TuiAltScreen`/`TuiMainScreen` 生成 `Frame`，唯一 `TerminalWriter` 串行写入 | 迁移后旧路径删除；离线 baseline 禁止真实 stdout |
| `src/ink/terminal.ts`、`src/ink/terminal-querier.ts` | lifecycle/query 直接写 ANSI、读 stdin | `terminal/lifecycle` 生成 `TerminalControlOperation`，query 只消费匹配 generation 的 response | 最终包只保留 v2 lifecycle/query owner |
| `src/dsh-adapter/plugin.ts`、update launcher | plugin/update、退出和重启路径可能绕过 renderer | coordinator/`ScreenTakeover` 或 child owner；恢复时 generation++、full redraw，异常走专用退出码 | side effect 只执行一次，child output 不进入第二 writer |
| `src/screens/Chat.tsx` | 业务分支中的 console/stdout patch | `ChannelUiAdapter`/controller 产生 event；诊断走受控 stderr/file | 迁移完成后不再保留直接 stdout 路径 |
| DSH tool、external editor、shell child | stdout/stderr 或暂时 tty takeover | adapter transcript 清洗，或声明 child 暂时拥有 tty；两者不得混用 | compare 只比较 event/frame，不复制 child 输出 |
| plugin `console.*`、第三方 logger | 未声明的 stdout/stderr | 默认拒绝/重定向至 diagnostics；allowlist 必须绑定 plugin/instance/cleanup | 未登记写入阻断最终合并 |

验收时使用 `pnpm verify:tui-v2 -- --check ownership --output "$RUNNER_TEMP/tui-v2/ownership.json"`，报告扫描根、直接调用位置、allowlist、owner、generation 和 stream queue 证据；最终全仓 guard 必须证明旧路径已迁移或删除，不能依赖长期 allowlist。所有 check/bench/soak artifact 默认写入 `$RUNNER_TEMP/tui-v2`（脚本负责 `mkdir -p`、原子 rename 和清理）；若本地需要保留 `artifacts/tui-v2`，必须由显式 `--output` 指定并由 `.gitignore`/CI cleanup 管理，不能成为默认未跟踪产物。

---

## 7. DSH 集成与迁移边界

### 7.1 保留的领域边界

以下能力保留在现有 DSH/Cordis adapter：session event、工具执行、审批、用户问题、模型/预设/effort、workspace、settings、plugin lifecycle、session resume/rewind、effect ledger 和权限/契约验证。v2 只改变 UI 事件进入和展示方式。

### 7.2 Channel UI adapter

领域层继续保留 `Channel` 公共接口；v2 在其上建立最终的显式 UI adapter：

```text
Channel.subscribe/version/rows/status/actions
  -> ChannelUiAdapter
  -> AppEvent + UiSnapshot
  -> v2 reducer/selectors
```

bridge 的责任：

- 当前 `Channel.subscribe(listener)` 和 `emitStream()` 只提供唤醒/version 变化，不携带 payload；adapter 必须在唤醒后读取并 deep-snapshot `rows`、嵌套 `ToolRow`、stores，再以 `snapshotHash + adapter seq` 做 diff。不能声称从 `emitStream()` 直接得到 chunk、时间或完成边界；若要保留真实 chunk 边界，必须新增显式 event feed，否则按 diff 生成合并后的 `stream/chunk`，并在 trace 中标记来源。
- 把 `rows` 的稳定 id、folded/restored、tool view、duration、seq 转成 `UiRowSnapshot`；原位可变的数组/对象在 bridge 边界复制，settled row 的 revision 固定。
- 把 `submit/steer/cancel/rewind/resume/...` 暴露成 controller command，不让 component 调用 channel。
- 订阅 question/approval/dialog/status stores，并分配明确优先级。
- 在 resume/new session/rewind/clear 等 reset epoch 变化时发送完整 `session/rows-reset`，清理旧 row cache 和 viewport anchor；快照缺口或 hash 不一致时优先 reset，不静默丢行。

生产接线必须从 `src/dsh-adapter/plugin.ts` 开始：TTY 校验、`cordis.patch.yml`/service 注册完成后创建 coordinator/bootstrap，所有现有 React mount 替换为 v2 lifecycle，同时覆盖 child stderr guard、update restart、teardown-vs-user-exit、resume marker、`finishExit` 和终端清理。`src/index.ts`/`scripts/run.ts` 的 profile/env/HMR/launcher 语义保持不变；不能只把 `channel.ts -> Chat.tsx` 当作完整启动链路。`scripts/run.ts` 的 heap-watch/diagnostic sampler 也必须由 lifecycle 注册并在 stop/teardown 清除或保持明确 `unref`，不能成为 v2 之外的永久 timer。

### 7.3 Chat.tsx 拆分映射

| 当前责任 | v2 目标位置 |
| --- | --- |
| `useSyncExternalStore` 订阅 channel/store | `ChannelUiAdapter` + `SessionEventController` |
| streaming、spinner、token/tps 状态 | `streaming.ts` + model selectors |
| prompt/editor 输入 | `EditorController` + `editor/` components |
| approval/question/plugin dialog 优先级 | `dialogs.ts` + overlay stack |
| scroll/new-message/loadOlder | `scrolling.ts` + `ViewportModel` |
| slash commands、workspace、model/preset/settings | `commands.ts` + picker components |
| 消息行视觉分支 | `components/transcript/` registry |
| fullscreen/inline 选择 | coordinator/bootstrap；组件不判断物理 screen |
| selection/search/copy | model selection state + compositor layer |
| trajectory/session browser/settings 场景切换 | scene controller；通过最终 v2 scene/UI adapter 复用 |

### 7.4 插件扩展

当前 `src/dsh-adapter/scenes.ts`、`src/scenes.ts` 与 `docs/plugins.md` 将 scene 定义为持有宿主 React、`ui`、`channel`、`close` 的整屏 React component，`package.json` 还公开 `./scenes` 与 `./jsx-runtime`。本次实现将所有仓库内 scene 一次性迁移到最终 `SceneV2` contract，并在同一 breaking release 删除 React scene exports；不设置 legacy adapter 或中间弃用窗口。

插件不得直接持有 v2 renderer internals。保留现有 plugin spec 和 grant 边界，只增加稳定的 UI capability。版本校验在注册时完成：宿主只接受声明了 `apiVersion: '2'` 的 descriptor；旧 React descriptor 直接返回结构化 `unsupported-scene-api` 并要求按 breaking-release 迁移，不能提供 legacy adapter，也不能在运行期猜测：

```ts
export type SceneCommand =
  | { type: 'dispatch'; commandId: string; payload: SerializableValue }
  | { type: 'focus'; target: 'scene' | 'overlay' }
  | { type: 'close'; reason: 'user' | 'error' }
export interface SceneCapabilityContext {
  readonly pluginId: string
  readonly instanceId: string
  readonly sceneId: string
  readonly takeover: TakeoverToken
  dispatch(command: SceneCommand): void
  close(reason?: 'user' | 'error'): Promise<void>
}
export interface SceneV2 extends Focusable {
  readonly apiVersion: '2'
  readonly sceneId: string
  render(view: SceneViewModel, width: number, context: SceneCapabilityContext): string[]
  handleInput?(event: string | TerminalInputEvent): void
  invalidate(): void
  onClose?(reason: 'user' | 'teardown' | 'error'): void | Promise<void>
}
export interface SceneComponentAdapter extends Component {
  readonly scene: SceneV2
}
export interface SceneDescriptorV2 {
  apiVersion: '2'
  id: string
  title?: string
  requiredGrants: readonly string[]
  commands: readonly SceneCommandDescriptor[]
  create(context: SceneCapabilityContext): SceneV2
}
export interface SceneCommandDescriptor {
  commandId: string
  schemaVersion: number
  validate(payload: SerializableValue): void
}
export type SceneRegistration =
  | { status: 'accepted'; apiVersion: '2'; descriptorId: string }
  | { status: 'rejected'; code: 'unsupported-scene-api' | 'missing-grant' | 'duplicate-scene'; supported: readonly ['2'] }
export interface SceneRegistrationHandle {
  readonly result: SceneRegistration
  dispose(): void
}
export interface TuiSceneRuntimeV2Contract {
  /** Final API; the old React descriptor/register overload is removed in this breaking release. */
  register(descriptor: SceneDescriptorV2, identity?: unknown): SceneRegistrationHandle
}

export interface ToolRowView {
  rowId: string
  revision: number
  phase: 'running' | 'result' | 'error'
  call: SerializableValue
  result?: SerializableValue
  durationMs?: number
}
export interface PluginRowView {
  rowId: string
  revision: number
  pluginId: string
  data: SerializableValue
}
```

`SceneV2` 的 `SceneCapabilityContext` 是一次注册生成的 capability token，`pluginId + instanceId + sceneId` 是诊断和 row identity 的稳定前缀；`dispatch` 只接受 `SceneCommand`，其中 `commandId` 必须在 descriptor 注册时声明并通过该 plugin 的 schema validator，不能取得 `Channel`、Cordis context、writer 或 stdout。`takeover` 只是在宿主签发后注入的 opaque lease token，scene 不能据此自行 restore。宿主为每个 scene 建立 error boundary：factory、render、handleInput、dispatch、`onClose`/`unmount` 的异常都转成带 plugin/scene identity 的 `app/error`，先撤销该 scene 的 capability，再通过 `ScreenTakeover.restore()` 恢复前一个 layer，不能让异常穿透 coordinator。关闭和 teardown 的回调最多执行一次，并在重复调用时返回同一个已完成结果。`SceneV2.render()` 返回可变 `string[]`；唯一的 `SceneComponentAdapter` 将绑定的 view/context 转成 pi `Component.render(width): string[]`，外部只读消费者必须复制数组，禁止把 `readonly string[]` facade 直接传给 pi。

`TuiSceneRuntime.register(descriptor: SceneDescriptorV2, identity?)` 是最终公开注册 API；注册时完成 `apiVersion`、grant、command schema 和 duplicate 校验，返回 `SceneRegistrationHandle`。所有 scene 都由 coordinator 创建并取得 `ScreenTakeover` lease，不能访问 React、Channel、writer 或 stdout。scene factory/render/handleInput/dispatch/close 的异常统一转成 `app/error`，撤销 capability 后恢复前一个 layer；关闭和 teardown 回调最多执行一次。仓库内所有现有 React scene 必须在本次实现中完成等价迁移，并提供包级 import/export smoke；外部插件按 breaking-release 迁移文档升级，不能依赖最终包中的 legacy adapter。

- 注册 command、status contribution、dialog、scene 或 row renderer。
- v2 row renderer 输入序列化的 `ToolRowView`/`PluginRowView`，输出 `Component` 或可变 `string[]`；scene v2 输入不可变 `SceneViewModel`，输出 line component，并通过 capability token 获取 dispatch/close，不暴露 React/Channel。
- 插件 component 不能拿到 `TerminalWriter`、stdout、DSH session 或 Cordis context。
- 插件异常转换为 `app/error` 或受控 notice，不得破坏主 frame。
- 本次 breaking release 直接删除 `./scenes` 的 React descriptor 和 `./jsx-runtime`；仓库内插件 fixture、文档和 package exports 必须同时更新，不能以“兼容窗口”推迟删除。
- v2 对外只通过版本化 `./tui-v2`/plugin capability export 暴露 `Component`、`SceneViewModel`、序列化 row、`SceneDescriptorV2` 和 typed command；不导出 vendor、Frame buffer、TerminalWriter 或 ANSI builder。新 export 的 semver、grant、identity、error-boundary 和 lifecycle 语义必须有包级 smoke/fixture。

---

## 8. 一次性实施工作包

本节不是发布路线，也不要求中间版本、灰度开关或“先做一个能跑的半成品”。WP-01--WP-09 是同一实现分支中的依赖有向图：可以在分支内并行开发，但只有所有工作包和最终验收全部通过后，才合并/发布一次完整替换。每个工作包的命令只是本地依赖检查，不单独提交、合并或发布；不允许为了通过检查保留临时 v1/v2 分支、兼容 adapter 或空壳 API。

依赖关系：`WP-01` -> (`WP-02`、`WP-03`) -> `WP-04` -> `WP-05` -> `WP-06` -> (`WP-07`、`WP-08`) -> `WP-09` -> 最终验收。所有工作包都必须在同一提交集合中完成；若任一包未完成，不能进入 merge/release。

### WP-01：基线、契约和 testkit

**目标：** 冻结旧 renderer 的可重放基线，并建立最终 renderer 的契约与 testkit；旧 renderer 不作为生产实现继续维护。

**工作项：**

- 将旧 renderer 标记为离线 baseline，禁止在其上新增大型布局/缓存/协议能力；它不属于最终 runtime，除 P0 数据/安全证据外不再修改。
- 在同一实现分支建立完整的 `test:tui-v2`/`verify:tui-v2` runner 和 lifecycle smoke；工作包只能扩展同一套 fixture，不能以尚未注册的命令作为出口。
- 固定基线运行命令、Node 版本、终端 profile 和当前回归脚本；新增跨平台 `scripts/bench-tui-v2.ts --fixture <id> --output <path>`，不得复用带硬编码工作目录的旧 `scripts/perf-probe.cjs`。
- 为现有退出、resize、streaming、shrink、CJK、resticky 行为补齐可执行入口。
- 记录当前内存/frame/input 延迟基线；无法测量的指标先标为 unknown，不用主观结论替代。

**依赖检查（不单独提交或发布）：** `pnpm compile`、`pnpm verify:build`、迁移台账中的现有 CI 命令、`pnpm test:tui-v2 -- --test-name-pattern lifecycle`；产物为基线 JSON（Node/OS/profile/fixture/commit）和 clean-stop 子进程报告。任一现有回归、退出码/终端模式不恢复或基线字段缺失即阻断最终合并。WP-01 不修改旧 renderer 行为，也不承诺同进程 fallback；回滚只由最终发布的上一版本/launcher 提供。

### WP-02：故障回放语料与 testkit

**目标：** 在实现 renderer 前，让关键 bug 可重放、可比较。

**事件 trace 最小集合：**

```text
startup
welcome
user submit
assistant stream chunks
reasoning start/end
tool start/result/error
approval open/accept/reject
question open/answer/cancel
overlay open/move/shrink/close
scroll up/down/sticky restore
editor insert/delete/cursor/history/submit
selection start/update/clear
notification/status/shortcut changes
scene open/close/error and plugin contribution
resize width/height changes
resume/rewind/new session
interrupt
SIGCONT
exit/error
```

**工作项：**

- 定义版本化 JSONL trace schema：`traceVersion`、`generatorVersion`、`seed`、`terminalProfile`、`events`、`expectedState`、`expectedGrid`、`oracle` 和 `redactionVersion`。核心 fixture 的 `expectedGrid` 必填；没有 golden 的探索性 trace 必须明确标记为 `oracle: differential-only`，不能作为发布 gate。
- trace capture 边界包含 editor buffer/cursor、viewport scroll/sticky/unseen、selection、question/approval/dialog stores、status/shortcut/scene runtime、terminal capability/resize/signal 和 reset epoch；session log 只覆盖业务事件，不能单独作为 UI replay oracle。
- 从 `docs/project-documentation/rendering.md`、现有 verify 脚本和 issue/debug 日志提取脱敏 fixture。
- 实现 stateful `VirtualTerminal`：解析 ANSI/OSC/DEC、维护 cursor/modes/scrollback/cell grid，支持 resize、partial write、late patch、generation 和 cleanup；初始状态固定为空屏、cursor `(0,0)`、默认 mode，并提供 `snapshot()`/`reset()`。
- 以锁定版本的 `@xterm/headless`（在同一变更中记录确切版本，不能使用 `^`）作为一个 oracle，同时保留最小独立 parser；两者通过 ANSI/OSC/DEC conformance fixture 对照，明确不支持序列的 conservative 行为。
- xterm/headless 只作为已声明序列的终端语义参考，不是产品 `renderFull` 的实现依赖；本地 parser 必须独立维护 cursor/mode/scrollback 不变量。两者对同一 conformance fixture 不一致时报告失败并保留双方快照，不能任选一个结果把冲突吞掉；产品语义仍由人工审阅的 golden cell-grid 决定。
- 实现 `renderFull(state)` 与 `replayPatch(oldGrid, patch)` 对照器；差分等价与产品语义 golden 分开，至少提交首帧、resize、scrollback、overlay、cleanup 五类独立 golden cell-grid。
- 失败时保存 trace id、generator version、seed、frame id、profile、state/generation、diff cell 坐标和最近 N 个事件；N 有上限，随机失败必须直接写出可重放 JSONL fixture。

**依赖检查（不单独提交或发布）：** `pnpm test:tui-v2 -- --test-name-pattern 'trace|virtual terminal|redaction'` 和 `pnpm verify:tui-v2 -- --check trace`；产物为版本化 fixture、golden grid、parser conformance 报告和迁移台账。核心 trace 全部可从 clean `VirtualTerminal.reset()` 重放；differential parser、xterm/headless 和产品 golden 的生成路径必须至少有一个与被测 renderer 独立，产品 golden 不得由 `renderFull` 自动生成；任一控制序列注入、宽度越界、seq 乱序未定义或 fixture 无 seed 即阻断。

### WP-03：pi fork 与终端内核

**目标：** 引入最终版本的 line component、diff、输入、main/alt screen 双 backend 基础。

**工作项：**

- 以 `@earendil-works/pi-tui`（pi `packages/tui`）commit `086c32e74530564922d011ade23ff582c9d63116`、包版本 `0.84.2` 为唯一 source；记录仓库 URL、commit、包 metadata/lockfile、许可证、NOTICE、所有 vendored 文件（含平台 native 目录）及 sha256 清单。Kimi Code 的 `@moonshot-ai/pi-tui` 不得混入同一 fork。
- native 目录只有在选定的 image/Windows input 能力需要时才构建；每个平台必须有 prebuild/source/hash 和无 native artifact 时的 conservative fallback。Linux CI 不得因为未编译 darwin/win32 native 而隐式跳过测试，tarball 不能带未声明的二进制。
- 只移植 dsh-TUI 需要的模块：`Component`、基础 stack/text/editor/scroll、layout、tui core、terminal、main/alt screen、width/utils。
- 建立 `src/tui-v2/terminal` facade；禁止业务代码直接 import vendored 内部路径。
- 提交 `PiTerminalAdapter`/pi `Terminal` method matrix：`start`、`stop`、`awaitStop`、`drainInput`、`columns`、`rows`、`kittyProtocolActive`、`moveBy`、`hideCursor`、`showCursor`、`clearLine`、`clearFromCursor`、`clearScreen`、`setTitle`、`setProgress` 逐项有 compile smoke、生命周期映射、backpressure/error 语义和 fixture；fork 的 `Tui`/main/alt screen 调用点全部改走 `PatchSink`，兼容 `write(string)` 的严格 parser/unknown-sequence rejection 规则按 5.6 执行。
- 保留上游测试并移植到本项目 test runner；每个本地修复与测试一一对应。
- 明确 fork patch ledger：文件、上游行为、DSH 改动、原因、测试、重新 vendoring 步骤。

**依赖检查（不单独提交或发布）：** `pnpm test:tui-v2 -- --test-name-pattern 'pi fork|terminal|overlay'`、`pnpm verify:tui-v2 -- --check fork`、`pnpm verify:package`；产物为 fork manifest、文件 hash、MIT `LICENSE`/`NOTICE`、patch ledger、上游测试报告和 tarball 检查。可在 virtual terminal 中渲染静态 text、输入 editor、resize、overlay 和 clean stop；v2 目录无 React/Yoga import，tarball 缺 `LICENSE`/`NOTICE` 或仓库/source artifact 缺 ledger/hash 时阻断。

### WP-04：状态模型、adapter 和最小纵向切片

**功能范围：**

```text
启动 -> 欢迎页 -> 用户消息 -> assistant streaming
     -> 一个工具调用/结果 -> editor -> Ctrl+C -> 正常退出
```

**工作项：**

- 创建 `UiState/reducer/selectors` 和 `ChannelUiAdapter`。
- 实现 transcript 的 user/assistant/tool 三种 component。
- 实现 editor、status、spinner、cancel 和 terminal lifecycle。
- 用同一组离线 trace 分别运行隔离的旧 baseline capture 和最终 renderer，输出最终 cell grid、frame 数、写入字节、峰值内存；比较过程不得启动第二个真实 TUI。
- 最终 bootstrap 直接使用 v2，删除 `DSH_TUI_RENDERER` 选择逻辑；旧 baseline 只由 compare harness 离线调用。

**依赖检查（不单独提交或发布）：** `pnpm test:tui-v2 -- --test-name-pattern 'walking skeleton|input|stream'`、`pnpm verify:tui-v2 -- --check skeleton`；产物为最终 renderer 的 trace 报告和 child-process cleanup 报告。核心 trace/profile 清单逐项通过，Ctrl+C、SIGTERM、异常后 raw/alt/mouse/paste/cursor 恢复；未实现功能必须在同一提交集合中完成，不允许用旧 baseline 或任何 fallback 临时遮蔽。任一未登记 TypeError、frame mismatch 或子进程超时即阻断。

### WP-05：controllers、replay 和业务 adapter

**实现依赖顺序（同一提交集合内，可按资源并行）：** session event normalization -> replay/resume/rewind -> streaming -> input/editor -> commands -> approval/question -> scrolling。

**工作项：**

- 将所有副作用从 Chat.tsx 移入 controller；reducer 保持纯函数。
- 为每个 controller 定义输入事件、输出 AppEvent、取消和错误语义。
- 处理 session reset、fold/loadOlder、pending steer/followup、tool error、interrupt、update restart。
- 为 approval、question、plugin dialog 建立 overlay focus/capture 优先级。
- 用 event trace 验证实时事件和 replay 事件得到相同 `UiState`。

**依赖检查（不单独提交或发布）：** `pnpm test:tui-v2 -- --test-name-pattern 'controller|replay|adapter'`、`pnpm verify:tui-v2 -- --check controllers`；以 canonical state serializer 比较 live/replay，覆盖 duplicate/out-of-order/gap/reset/resume/rewind/cancel；controller 无 stdout 写入，component 无 DSH/Cordis import。缺少 seq 语义、异步 timer 未取消或 live/replay canonical state 不等价即阻断。

### WP-06：fullscreen backend 与 compositor

**工作项：**

- 实现完整 base viewport、sticky scroll、new-message indicator、load older。
- 接入 compositor：overlay、selection、search、cursor、copy。
- 完成 Markdown、代码、diff、tool card 的基本 line component。
- 实现 resize transaction、SIGCONT recovery、Ctrl+L full redraw、异常 cleanup。
- 在 @xterm/headless/virtual terminal 中以 full render 对照差分 patch。

**依赖检查（不单独提交或发布；对应第 9.2、9.3、9.4 和第 10.1 节）：** `pnpm test:tui-v2 -- --test-name-pattern 'fullscreen|compositor|scroll|width'`、`pnpm verify:tui-v2 -- --check fullscreen`；核心 golden/fixture 的 cell、cursor、mode、物理行宽断言全部通过，任意 overlay 移动/缩放/关闭无残影，P0/P1 fixture 清单无未登记差异。旧 `src/ink` 的删除由 WP-09 在同一提交集合的最终清理项中完成。

### WP-07：inline backend

**工作项：**

- 明确 inline 支持矩阵：append-only transcript、底部 live region、有限通知、editor 和安全退出。
- 独立实现 main-screen scrollback、cursor anchor、shrink、resize 和第三方输出重锚。
- 禁止把 fullscreen 的逻辑复制成 `if (mode === 'inline')` 分支；共用的是 backend contract 和 ViewModel。
- 通过 trace 明确 inline 的功能差异，并在 UI 中使用一致的降级反馈。

**依赖检查（不单独提交或发布）：** `pnpm test:tui-v2 -- --test-name-pattern 'inline|scrollback|third-party output'`、`pnpm verify:tui-v2 -- --check inline`；产物为 main-screen scrollback 快照、第三方输出重锚和 terminal-mode cleanup 报告。核心 trace 可重放，无重复 scrollback、残影和模式泄漏；fullscreen 专属能力必须出现在支持矩阵中，不能静默伪装 parity。

### WP-08：全量组件、场景和插件迁移

按风险和依赖列出的实现清单（不代表发布阶段）：

1. Markdown 完整语法、代码高亮、表格和截断。
2. tool cards、tool output、错误和折叠。
3. approval/question、picker、help、history/search。
4. session browser、settings、workspace、model/preset/effort。
5. trajectory、goal/todo、activity、context bar、图片。
6. local `!`/shell command、clipboard、external editor、update restart、notifications、theme/i18n、plugin scenes。
7. custom themes、鼠标、OSC52、Kitty/iTerm2 图片能力和宿主特定 capability；sixel 明确不在 v2 图片协议内，必须走 fallback/unsupported notice。

每一项都必须新增 component contract 测试、宽度边界测试和至少一个 trace 场景，并登记对应的旧回归脚本迁移状态；高级能力不得阻塞核心退出/恢复。图片、OSC52、鼠标、Kitty negotiation、external editor/update 和 plugin crash 各至少有一个 subprocess/profile fixture，不能只依赖静态 component 测试。

### WP-09：最终集成、删除和一次性发布

**工作项：**

离线 compare harness 的 contract 固定如下；它属于 `tools/tui-v2-baseline/`，不得被 `src/tui-v2` 或最终 bootstrap import：

```ts
export interface V1CaptureRenderer {
  render(snapshot: UiSnapshot, options: {
    profile: TerminalProfile
    writer: FakeTerminalWriter
    virtualTerminal: VirtualTerminal
    traceId: string
  }): Promise<V1CaptureResult>
}
export interface FakeTerminalWriter {
  readonly writes: readonly string[]
  write(data: string): void
  writeControl(operation: TerminalControlOperation): void
  reset(): void
}
export interface V1CaptureResult {
  frame: Frame
  grid: CanonicalGridV1
  ansiBytesHash: string
  diagnostics: readonly SerializableError[]
}
```

`V1CaptureRenderer` 仅用于离线迁移对照，不是最终运行时能力：它由独立的 baseline tool 或预先冻结的旧版本 artifact 提供，在创建旧 Ink/React root 前注入 fake writer、fake clock、fake stdin 和 no-op DSH/Channel adapter；禁止注册真实 lifecycle listener、订阅 live Channel、执行 command、访问 `process.stdout/stderr`、写 session 或启动 timer。每个 capture 结束后销毁 root 并断言 writes 只进入 fake writer；compile/package smoke 要确保最终 bootstrap 和 runtime tarball 不能误用该 capture backend。WP-09 的完成定义包含 `tools/tui-v2-baseline/capture.ts`、`compare-harness.ts`、side-effect spy 和同一 trace 的离线 grid/frame/bytes report；baseline 缺失或写真实 stdout 即阻断最终验收。

baseline tool 使用冻结的旧版本 source/artifact 和独立的 dev-only 依赖边界；它可以包含 React/Ink 仅用于离线 capture，但不得被 `src/tui-v2`、生产 bootstrap、生产 package exports 或 runtime tarball 引用。删除 `src/ink` 和生产依赖不会破坏 compare：compare 必须能够从带有 source commit/hash 的冻结 artifact 重放，artifact 与最终包分开验证和发布。

- `DSH_TUI_RENDERER` 不再提供 v1/v2 选择；最终 bootstrap 只有一条 v2 路径。compare harness 只在离线 trace 中运行 `V1CaptureRenderer` 与最终 renderer，不能双订阅 Channel、重复执行 DSH side effect 或启动第二份真实 stdout。
- 对同一 session trace 记录离线旧 baseline 与最终 renderer 的 cell grid、ANSI bytes、frame duration、input latency、峰值/稳态内存；该报告用于替换审阅，不形成生产双跑依赖。
- fullscreen/inline、terminal profile 和 capability fallback 在最终配置中一次性确定；不提供 feature flag、灰度或临时 renderer switch。
- 发生 crash、错误增长或终端恢复失败时，当前进程只执行 cleanup 并以专用退出码结束；由上一发布包/独立 launcher 按 rollback manifest 重新拉起，不允许同进程自动切换 v1。所有路径用 child-process/PTY harness 验证。

**最终集成检查（不单独发布）：** 离线 compare、完整支持矩阵 soak（见 10.1）、`pnpm verify:tui-v2 -- --check regression-matrix` 和 child-process cleanup/rollback drill 全部通过；没有 `blockDefault: true` 的 open/in-progress P0/P1，所有关闭项有对应 artifact，所有仓库内 scene/plugin 已迁移，最终 bootstrap 无 renderer switch。任一未迁移功能、旧热路径、临时 fallback 或终端恢复失败都阻断最终合并。

### WP-09 内的最终清理项：同一变更中的旧链路删除与最终包清理

**工作项：**

- 在同一变更中完成 breaking-change/插件迁移说明、所有仓库内 scene/plugin fixture 迁移和旧链路删除；上一发布包只作为外部 rollback artifact，不作为当前包的运行时依赖。
- 删除 v1 renderer 的启动分支、旧 JSX 入口、`DSH_TUI_RENDERER` 环境选择和仅供迁移的 adapter/fallback。
- 删除 `react`、`react-reconciler`、Yoga 及仅由旧 Ink 使用的依赖。
- 删除 `src/ink`、`src/native-ts/yoga-layout` 和旧 screen 组件；在删除前由同一最终验收核对公共导出、插件 contract、构建产物和文档，不能把删除推迟到后续版本。
- 保留必要的历史迁移说明和 fork license，不保留可执行的第二套 renderer；`V1CaptureRenderer` 放在独立离线工具边界或由冻结 baseline artifact 提供，不能被 runtime import。
- 更新 README、架构文档、开发脚本、打包验证和安全边界。

**出口条件（命令 -> 产物 -> 阻断条件）：** `pnpm compile`、`pnpm verify:build`、`pnpm verify:tui-v2 -- --check v2-only`、`pnpm test:tui-v2`、`pnpm verify:package`、双 Node 矩阵 build；tarball 只含 v2 runtime、指定 license/NOTICE 和必要迁移文档，AST/dependency guard 确认无旧 reconciler/Yoga/React 热路径，公开 exports/plugin fixtures 通过，离线 baseline 工具不被 runtime 依赖。任一旧回归脚本因删除路径失效、包内容缺 license、旧选择开关残留或最终包包含第二套 renderer 即阻断。

---

### 工作包附录：现有回归迁移台账

最终实现集合必须提交 `docs/tui-v2-regression-matrix.md`。机器可读矩阵的每一行必须包含以下字段，缺一不可：

```json
{
  "id": "REG-001",
  "severity": "P0|P1|P2",
  "owner": "team-or-handle",
  "status": "open|in-progress|verified|accepted-risk|retired",
  "updatedAt": "2026-01-01T00:00:00Z",
  "traceId": "trace-name@version",
  "assertion": "canonical grid/mode/cleanup assertion",
  "ciCommand": "pnpm test:tui-v2 -- --test-name-pattern ...",
  "blockDefault": true,
  "deleteCondition": "具体的替代 fixture、最终提交条件或删除理由"
}
```

`severity`、`status`、`blockDefault` 只能取 schema 值；`updatedAt` 必须是 UTC RFC 3339，`traceId` 必须能在 fixture 中解析。每个旧入口还必须有 `disposition: rewrite-v2 | remove | offline-baseline`，不得出现 `keep-v1`、`dual-run` 或迁移专用兼容状态。矩阵的输入集合不是人工挑选：必须扫描 `.github/workflows/*.yml`、`package.json` scripts 和 `scripts/` 中由 CI/发布间接调用的入口，记录 `sourceCommit`、扫描命令和清单 hash。初始台账至少包含：

```text
rg -o 'scripts/[A-Za-z0-9_.-]+' .github/workflows package.json | sort -u
```

最终验收的 `verify:tui-v2 -- --check regression-matrix` 必须对扫描结果逐项检查：缺少处理状态、severity、trace、断言、owner、更新时间、CI 命令、`blockDefault`、`disposition` 或删除条件即失败；`P0`/`P1` 只在 `verified` 或 `retired` 且有通过 artifact 时才算关闭，`accepted-risk` 永远不能清除默认阻断；`blockDefault: true` 的 open/in-progress 条目必须使最终 gate 非零。新增 CI 脚本若未更新矩阵也失败。发布 workflow 与 PR CI 分开记录，但两者都必须指向同一最终实现；不得用保留旧入口或双跑作为豁免。

| 现有入口 | v2 trace/断言 | 责任工作包 | 最终处理 |
| --- | --- | --- | --- |
| `scripts/repro-askpanel.tsx`、`scripts/verify-askpanel-layout.tsx` | question/overlay、窄宽和 resize golden | WP-08 | `rewrite-v2`，旧入口删除 |
| `scripts/repro-toolcards.tsx`、`scripts/repro-diff-split.tsx` | tool/diff line component + width | WP-08 | `rewrite-v2`，旧入口删除 |
| `scripts/repro-pill.tsx`、`scripts/verify-scroll.mjs`、`scripts/verify-shrink.mjs` | sticky/unseen/shrink scroll state | WP-05/WP-06 | `rewrite-v2`，旧入口删除 |
| `scripts/repro-inline-scrollback.tsx`、`scripts/repro-inline-thirdparty.tsx` | main-screen scrollback/第三方输出 | WP-07 | `rewrite-v2`，旧入口删除 |
| `scripts/verify-keys.tsx`、`scripts/verify-terminal-queries.tsx`、`scripts/verify-win32-input.tsx` | tokenizer、profile query、ConPTY 输入 | WP-03/WP-07 | `rewrite-v2`，旧入口删除 |
| `scripts/verify-teardown-exit.tsx`、`scripts/verify-shutdown-stderr.tsx` | child-process cleanup/console restore | WP-03/WP-09 | `rewrite-v2`，旧入口删除 |
| `scripts/verify-extension-events.tsx`、`scripts/verify-extension-ui.tsx` | plugin event/dialog/scene boundary | WP-05/WP-08 | `rewrite-v2`，旧入口删除 |
| `scripts/verify-resize-reflow.tsx`、`scripts/verify-message-measure-depth.tsx` | resize/长列表高度回归 | WP-05/WP-06 | `rewrite-v2`，不用旧 Yoga oracle |

删除 `src/ink` 前，台账中所有旧入口必须为 `verified` 或 `retired`，且 `disposition` 已明确；`offline-baseline` 必须附冻结 artifact、隔离边界和维护者确认。

## 9. 测试与验证策略

### 9.0 可执行入口与产物

在同一实现集合中新增以下脚本和目录（同步修改 `package.json`、CI 和发布 workflow）：

```text
test/tui-v2/**/*.test.ts          # node:test + tsx/esm；确定性单测、replay、virtual terminal
test/tui-v2/goldens/**/*.json     # 独立 cell-grid golden（trace 不含 secret）
fixtures/tui-v2/**/*.jsonl       # 版本化 trace，失败随机样本直接落盘
scripts/verify-tui-v2.ts          # --check、--profile、--fixture、--output
scripts/bench-tui-v2.ts           # --fixture、--iterations、--seed、--output
scripts/soak-tui-v2.ts            # child-process/PTY，--minutes、--profile、--output
scripts/test-tui-v2.mjs           # 递归发现、Node test runner、JSON reporter wrapper
scripts/tui-v2-test-reporter.mjs  # Node 22/24 兼容的 versioned object-mode reporter
scripts/verify-tui-v2-tarball.mjs # exact tgz/hash/file-manifest/license/exports verifier
```

固定命令：

```text
pnpm test:tui-v2 -- --output "$RUNNER_TEMP/tui-v2/test.json"
pnpm verify:tui-v2 -- --check <check> --output "$RUNNER_TEMP/tui-v2/<check>.json"
pnpm bench:tui-v2 -- --fixture streaming-100k --iterations 5 --seed 1 --output "$RUNNER_TEMP/tui-v2/bench.json"
pnpm soak:tui-v2 -- --minutes 10 --profile unknown-conservative --output "$RUNNER_TEMP/tui-v2/soak.json"
```

`test:tui-v2` 固定调用 `node scripts/test-tui-v2.mjs`，不能把 `test/tui-v2` 目录作为 Node module 参数，也不能依赖 shell 的 `**` 展开。wrapper 使用 Node `fs/promises` 递归发现 `test/tui-v2/**/*.test.ts`，按 POSIX 相对路径排序，发现目录不存在或文件数为零即失败；然后使用 `process.execPath` 启动子进程：`--test --test-timeout=120000 --import tsx/esm --test-reporter=<absolute-file-url-to-tui-v2-test-reporter> --test-reporter-destination=<temporary-json>`，最后追加显式文件路径。`scripts/tui-v2-test-reporter.mjs` 必须导出 Node 22.19/24 都支持的 object-mode `Transform` reporter，固定 `reporterVersion: 1`、事件 `type`/`name`/`nesting`/`data` 的 JSONL schema，不依赖不存在的 `json` 内置 reporter；wrapper 将 reporter module path 解析为绝对 file URL，解析并规范化 JSONL 事件，向 `--output` 或默认 `$RUNNER_TEMP/tui-v2/test.json`（无 `RUNNER_TEMP` 时使用 `os.tmpdir()/tui-v2/test.json`）原子写入 `{ schemaVersion: 1, status, exitCode, signal, files, selectedPattern, tests, failures, startedAt, durationMs, node, platform, cwd, gitHead, lockfileHash }`；启动失败、reporter 加载失败/空输出、发现失败、失败测试、超时、被 signal 中止也必须在 `finally` 写出 artifact，并返回非零。`--test-name-pattern <regex>` 只作为 runner 参数转发，不能用于改变文件发现集合；未知 wrapper 参数失败。每个测试文件仍必须能单独以同样的 `process.execPath --test --import tsx/esm <file>` 运行，并增加 Node 22.19/24 reporter compile/smoke fixture。

PR gate 运行 unit/replay/virtual-terminal、10 分钟 bounded soak；nightly 运行 8 小时 soak 和真实宿主 job；release gate 运行 24 小时 soak、双 Node 矩阵、package dry-run。所有命令写出 JSON summary、commit、Node、OS、profile、fixture、seed、duration、失败 cell/事件，并作为 CI artifact 上传；超时退出码非零。

PTY 能力必须有明确的 runner contract：`soak:tui-v2` 在 PR 默认使用仓库内 `FakeDuplexTerminal`/fake stream，保证 clean `pnpm install --frozen-lockfile` 后可执行；nightly/release 的 `--require-pty` 才启动真实 PTY。真实路径使用 exact-pinned `node-pty@1.1.0` devDependency（版本、lockfile entry、native artifact/build toolchain 和 runner image 写入 `docs/tui-v2-pty.md`），不依赖个人机器的 `DSH_CC_NODE_PTY`；若仍允许该环境变量，只能指向 capability manifest 中登记且 hash 匹配的 binary。`--require-pty` 无法加载 node-pty、native binary、Windows ConPTY 或宿主能力时必须返回非零并写 `pty-unavailable` artifact，不能静默标记 skipped；PR fake-stream soak 与真实 PTY soak 的证据在 JSON 中区分，二者不能互相冒充。

trace 分为受保护的本地 capture 和可提交的脱敏 fixture：前者可在权限目录短期保存受限原始输入，后者的 `expectedState` 只保留语义字段/哈希，`expectedGrid` 必须使用固定的 `gridEncoding: 'readable' | 'sha256-v1'`（见 9.2），不能由每个测试自行选择文本或 hash 表示。redaction 必须在写盘前执行并有“prompt、tool args、OSC payload、credential 不出现在公共 artifact”测试；`sha256-v1` golden 只证明 canonical grid 等价，不得宣称可读审阅，readable golden 必须由维护者显式审阅后才进入仓库。

### 9.1 测试层次

| 层次 | 目标 | 典型内容 |
| --- | --- | --- |
| 纯函数单测 | 不依赖终端的确定性 | reducer、selectors、width、wrap、truncate、key parser、cache eviction |
| component contract | 宽度和输入行为 | `render(0/1/2)`、CJK/emoji、focus、invalidate、overlay capture |
| controller replay | 事件顺序和副作用 | stream、tool、approval、resume、rewind、interrupt、commands |
| compositor/frame | 图层与光标 | overlay 移动/缩放/关闭、selection、cursor、clip、full redraw |
| virtual terminal | ANSI 语义和差分正确性 | old grid + patch = full render grid、scrollback、resize、modes |
| integration | DSH adapter 接线 | 真实 Channel/session fixture、plugin dialog/status、external editor |
| soak/benchmark | 长时间资源行为 | 10 万事件、长流式、8--24 小时、frame/input latency、writer backpressure |
| manual matrix | 真实终端差异 | Windows/ConPTY、tmux、SSH、VS Code、Kitty、Ghostty 等 |

### 9.2 核心断言

```ts
export interface CanonicalImagePlacement {
  readonly imageId: string
  readonly protocol: 'kitty' | 'iterm2'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly payloadHash: string
}
export type CanonicalStyle = Omit<StyleDescriptor, 'id'>
export type CanonicalHyperlink = Omit<HyperlinkDescriptor, 'id'>
export interface CanonicalCell {
  readonly grapheme: string
  readonly width: 0 | 1 | 2
  readonly continuation: boolean
  readonly resolvedStyle: CanonicalStyle
  readonly hyperlink: CanonicalHyperlink | null
}
export interface CanonicalGridV1 {
  readonly width: number
  readonly height: number
  readonly cells: readonly CanonicalCell[]
  readonly cursor: SerializableValue
  readonly modes: TerminalModeSnapshot
  readonly scrollback: readonly (readonly CanonicalCell[])[]
  readonly images: readonly CanonicalImagePlacement[]
}
```

所有 golden 使用同一个 `CanonicalGridV1`：`{ width, height, cells, cursor, modes, scrollback, images }`。每个 cell 展开为 `{ grapheme, width, continuation, resolvedStyle, hyperlink }`，其中 `continuation` 由 `width === 0` 且空 grapheme 明确表示；`resolvedStyle` 是从 frame-local `StyleDescriptor` pool 展开的完整颜色/属性对象，`hyperlink` 是展开后的 `{ id, uri, params } | null`，不能比较 frame-local 数字 id。`images` 按语义顺序包含 `{ imageId, protocol, x, y, width, height, payloadHash }`，不包含 ephemeral `storeKey`；图片 operation、协议、位置或 payload hash 任一不一致都使 golden 失败，未支持图片也必须显式记录 `unsupported-image` placeholder/diagnostic。`modes` 使用第 5.5 节定义的完整 `TerminalModeSnapshot`，scrollback 按行顺序包含同样的 canonical cells。canonical JSON 固定为 UTF-8、对象 key 按 Unicode code point 字典序、数组保持语义顺序、数字采用 ECMAScript shortest decimal、无空白和 trailing newline；`sha256-v1` 对该 UTF-8 字节串计算 SHA-256，并以 lowercase hex 保存。golden 形状固定为 `{ gridEncoding: 'readable' | 'sha256-v1', value: CanonicalGridV1 | string }`；`readable` 的 value 必须仍是完整 canonical grid，不是只含可见文本的摘要。

`compareGrid(actual, expected)` 是唯一断言入口：`readable` 先校验 schema 后做 canonical deep-equal，`sha256-v1` 对 actual canonical bytes 计算 hash 后比较版本和 hex；测试不得直接写 `cellGrid == expectedGrid`，不得把 redacted hash 解码成“可读”结果。失败报告同时输出脱敏的坐标、expected/actual cell hash 和 encoding/version。

每个 diff frame 都执行以下两类对照。第一类是 differential equivalence：

```text
expected = renderFull(currentState, terminalProfile)
expectedGrid = canonicalize(expected)
actual = virtualTerminal(previousGrid, rendererPatch)
assert(compareGrid(actual, expectedGrid))
assert(actual.cursor == expected.cursor)
assert(actual.modes == expected.modes)
assert(noPhysicalLineExceedsViewport(actual))
```

第二类是独立语义 oracle：核心 trace 在首帧、resize、scrollback、overlay、cleanup 五个 golden 中必须带 `expectedGrid`、cursor、modes 和 scrollback hash；golden 由锁定的 xterm/headless 或人工审阅的 cell fixture 生成，不能由被测 `renderFull` 自动生成。差分等价通过但语义 golden 失败仍是阻断。

`VirtualTerminal` 必须按 `reset -> start -> write chunks (可拆分) -> flush -> snapshot` 重放，并能插入 resize、stop、late patch 和 writer backpressure；测试不是无状态的 `oldGrid + patch` 函数。无法安全局部更新时，允许 `fullRedraw`，但不允许输出错误 grid、过期 generation 或污染 scrollback。

随机 property test 使用固定 `generatorVersion`、seed、迭代预算（PR 每类 1,000 次，nightly 每类 50,000 次），覆盖宽度 0--160、任意 grapheme 序列、ANSI style/OSC payload、overlay 尺寸变化、滚动和 resize 顺序。失败必须保存完整 seed、最小化输入和可直接运行的 JSONL fixture。

### 9.3 必须有的回归 fixture

- 单个 CJK grapheme 在 width=1 时不递归、不溢出、不丢失后续 cursor。
- ZWJ emoji、regional indicator、组合字符和宽字符边界不被劈开。
- CJK URL/Markdown 链接在边界处不多一列或少一列。
- ANSI SGR/OSC 8 在换行、截断、overlay 覆盖后 style 不泄漏。
- 长流式行不会因 cache key 持有 sliced string 造成单调堆增长。
- 完成 row 的 cache 不因 spinner、通知或其他 row 更新而失效。
- overlay 覆盖 transcript 后缩小、移动、关闭，base cell 完全恢复。
- resize 在 stream、dialog、selection、scroll 中发生时不重复、不残影、不坐标漂移。
- sticky scroll 打断后只在明确到达底部时恢复，new-message count 正确递减。
- `Ctrl+C` 在 working/idle/second press 三种状态都能得到预期结果。
- SIGINT、SIGTERM、异常、stdin close、update restart 后 raw mode/alt screen/mouse/paste/cursor 全部恢复。
- 主屏 inline 不把每次局部更新复制进 scrollback，不使用清空 scrollback 的危险序列作为常规路径。
- 用户/tool 文本中的 C0、CSI、OSC、DEC、OSC 8/52 payload 被当作数据清洗；fuzz 后 terminal mode、cursor、scrollback 和 writer generation 仍满足不变量，不允许注入 raw mode、标题、剪贴板或同步输出序列。
- writer highWaterMark、partial write、write error、过期 frame、cleanup timeout 和 capability query timeout 都有 child-process 或 fake stream fixture；异常必须有有限、脱敏诊断。
- external editor/update 暂停/恢复、第三方 stdout/stderr、plugin component 抛错、Kitty keyboard negotiation、mouse、OSC52 和 image fallback 各有最小 trace/profile。

信号 fixture 使用 child process/PTY 隔离；Unix 断言 SIGINT/SIGTERM/SIGHUP/SIGCONT，Windows 用 Ctrl+C/Terminate/console resize 等价路径，SIGCONT 不支持时必须记录 `unsupported-by-host`，不能把测试跳过伪装成通过。

### 9.4 终端覆盖矩阵

确定性 emulator profile（不是实际宿主声明）至少包括：

```text
ascii-narrow
unicode-ambiguous-narrow
unicode-ambiguous-wide
kitty-sync
iterm2-images
tmux
ssh
windows-conpty
windows-terminal-powershell
windows-terminal-cmd
classic-conhost-cp65001
classic-conhost-cp936
vscode-terminal
unknown-conservative
```

真实终端验证另列为宿主 gate，记录终端/版本、`TERM`/`COLORTERM`/`TMUX`、尺寸、locale、Node、录制日志和负责人；当前 Ubuntu CI 不得把 Windows/macOS/SSH/tmux 写成已自动覆盖。至少安排 Windows + ConPTY、macOS、Linux+tmux/SSH 的 scheduled/release job，无法提供 runner 时保留为发布手工 gate。

真实手工验证至少覆盖：

- macOS：Terminal、iTerm2、Ghostty、Kitty。
- Linux：Kitty、Ghostty、tmux、SSH、VS Code terminal、JetBrains/JediTerm。
- Windows：Windows Terminal + PowerShell/cmd、ConPTY、classic conhost CP936/CP65001、Git Bash、VS Code terminal。

真实终端测试不替代 virtual terminal；virtual terminal 负责可重复的语义断言，真实终端负责 capability、字体和宿主差异。

---

## 10. 性能、内存与可观测性门槛

### 10.1 目标门槛

以下指标在确定的硬件、Node 版本、终端 profile 和 fixture 上测量；基线与最终门槛在同一实现集合中同时记录，不因工作包设置不同阈值。每次 benchmark 先 warm-up 100 个事件，正式样本至少 200 个；p95 使用样本排序的 nearest-rank，起点/终点、时钟和 queue 采样写入 JSON。benchmark/soak 子进程必须由固定命令以 `process.execPath --expose-gc --import tsx/esm` 启动，并在脚本开始断言 `typeof global.gc === 'function'`，否则立即失败；GC 前后分别记录 heapUsed，RSS 单独记录。屏幕 120x40，fixture 和 seed 固定；CI 仅比较同 runner 基线 ±20%，跨硬件不直接比较绝对值。

| 指标 | 目标 |
| --- | --- |
| 常规输入到 frame commit | p95 < 16 ms |
| 合并后的 stream frame | p95 < 33 ms |
| 空闲无动画 CPU | 60 秒窗口进程 CPU time / wall time <= 2%，不能有高频 polling/render loop |
| 长会话 | 10 万 settled 事件；强制 GC 后 heapUsed 相对 baseline 20k 窗口 <= 1.25 倍、RSS <= 1.5 倍；至少采集 5 个完整 20k settled-event window，首个完整窗口为 baseline、最后一个为 final。每个指标的 regression slope 必须 `<= 1 MB/10k events`，且 sustained-growth 检测同时满足 `monotonicIncreaseRatio < 0.9` **和** `R² < 0.8`；高斜率、近单调增长、拟合显著或任一窗口超过硬上限均失败，不能使用 OR 放过泄漏。 |
| soak | PR 10 分钟、nightly 8 小时、release 24 小时 streaming；无未处理 timer、listener 或 frame queue 增长，heap/RSS 规则同上 |
| 物理行宽 | 始终 `<= viewport.width` |
| resize | 每次改变宽高后无残影、重复和 cursor 漂移 |
| writer | `queueDepth <= 2` 个 frame、pending bytes <= 8 MiB；backpressure 可观测并只丢弃过期低优先级 frame，输入/exit 不得丢 |

输入 p95 从 tokenizer 产生 `InputEvent` 到包含该命令的 frame commit；若当时已有 write，不要求打断当前 write，但必须记录 `busyAtInput` 并把排队延迟单列，饱和 fixture 的 p99 不得超过 100 ms。stream p95 从 chunk 入 adapter 到合并 frame commit，不能把每个 token 当作独立 frame。

benchmark/soak JSON 必须额外记录 `runnerId`、CPU model/cores、RAM、container image/digest、OS/kernel、Node/npm/pnpm、git dirty 状态、HEAD commit、lockfile SHA-256、commandLine、profile、fixture 和 seed；缺少任一身份字段不能与历史基线比较。`bench:tui-v2` 和 `soak:tui-v2` 的固定入口分别为 `node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts` 与 `node --expose-gc --import tsx/esm scripts/soak-tui-v2.ts`（package script 不得漏掉 `--expose-gc`）。
趋势计算固定使用 window midpoint 的 least-squares regression；常量序列的 `R²` 规范化为 `0`，任何 NaN/Infinity、缺窗口或采样不完整均失败，不能通过“无数据”绕过泄漏门槛。

### 10.2 有界资源清单

每个 cache/ring buffer 在代码和测试中声明：

- 最大 entry 数。
- 最大字符/字节预算。
- key 是否复制/脱离父字符串。
- FIFO/LRU/TTL 或 generation 淘汰策略。
- width/theme/profile/row revision 改变时的失效条件。
- 统计命中率、驱逐数和当前大小。

至少需要限制：row height cache、line width cache、grapheme/ANSI processed-line cache、trace ring、diagnostics ring、tps samples、pending render requests、clipboard/image metadata 和 plugin status/dialog 队列。

### 10.3 诊断数据

每个 frame 记录有限 metadata：`frameId`、`stateRevision`、`width/height`、`changedRows`、`fullRedraw`、`renderMs`、`diffMs`、`writeMs`、`bytes`、`queueDepth`、`cacheHitRate`、`terminalProfileId`。默认只保留最近 128--512 帧，debug dump 必须脱敏，不写入完整 prompt、工具参数或 credential。

```ts
export interface DiagnosticRecord {
  schemaVersion: 1
  traceId: string
  frameId?: string
  generation: number
  terminalProfileId: string
  kind: 'frame-mismatch' | 'writer-error' | 'cleanup-error' | 'capability-timeout'
  metadata: FrameMetadata
  eventSummary: readonly string[]
  diffCells?: readonly { x: number; y: number; expectedHash: string; actualHash: string }[]
}
```

发生 frame mismatch、writer error、cleanup error 或 terminal capability timeout 时，自动保存 v2 `DiagnosticRecord`：`schemaVersion`、trace/frame/generation、profile、metadata、事件类型摘要和 cell diff 坐标；禁止 prompt、工具参数、原始 ANSI、OSC payload、credential。文件使用用户专属目录、目录 0700、文件 0600，默认保留 7 天且总预算 50 MiB，CI artifact 同样只上传 redacted record。redactor 有敏感字段单测和字节扫描；旧 `DSH_TUI_RENDER_LOG` 原始 frame 日志不作为 v2 诊断实现，最终 runtime 必须禁用或隔离。

---

## 11. CI、代码审查和自动边界

### 11.1 必须自动化的边界

CI 增加以下 guard：

1. **最终 guard 扫描整个生产依赖图：** `src/tui-v2/**`/迁移后的 `components/**` 禁止导入 DSH/Cordis/session/Agent 和 Node process API；旧 `src/components/**`、`src/ink/**` 不得以 allowlist 留在最终生产路径，离线 baseline 工具必须单独列入非 runtime 扫描根。
2. `controllers/**` 禁止直接写 stdout、构造 ANSI/OSC/DEC。
3. `terminal/**` 之外禁止新增 lifecycle CSI/OSC/DEC 字面量；样式 SGR、hyperlink、image payload、测试 fixture 和历史 baseline fixture 分开登记，不能一刀切禁止所有控制序列。
4. 所有 cache 构造函数必须显式声明容量/预算/淘汰策略。
5. 所有 component 必须有 width=0/1/2 的 contract test；非 component 的 model/license/benchmark 任务使用对应类型 DoD（见 13.2）。
6. 所有新增 controller 必须有最小事件回放测试。
7. 所有 renderer fork patch 必须有对应 regression test 和 patch ledger 条目。
8. 新增 stdout/stderr 写入点必须通过 reviewer 认可的 allowlist，并登记 ownership（writer、query、cleanup、external child、插件/update）。
9. v2 目录不得依赖 React、`react-reconciler`、Yoga 或旧 `src/ink`。
10. build/package 验证必须检查 vendored license、导出边界、v2-only 依赖图和没有意外依赖。

实现方式可以用 `rg`/脚本 AST guard，必要时再迁移 ESLint `no-restricted-imports`、dependency-cruiser 或 TypeScript project references；脚本必须输出扫描根、任何例外命中、规则版本和退出码。最终 gate 必须扫描全仓库生产路径并确认旧 renderer 已删除；通过局部 guard 不能替代这一证明。

### 11.2 评审要求

每个 renderer/terminal 变更的 PR 描述必须包含：

- 影响的 invariant 编号。
- 复现 trace 和最小输入。
- 预期/实际 cell grid 或 terminal bytes 变化。
- 是否改变主屏/alt-screen 行为。
- cache/内存影响和上限。
- 新增/更新的回归测试。
- 如果是 fork patch：对应上游 commit、未来 re-vendor 操作和许可证影响。

新增 `package.json`/CI 约束：

```json
{
  "test:tui-v2": "node scripts/test-tui-v2.mjs",
  "verify:tui-v2": "node --import tsx/esm scripts/verify-tui-v2.ts",
  "bench:tui-v2": "node --expose-gc --import tsx/esm scripts/bench-tui-v2.ts",
  "soak:tui-v2": "node --expose-gc --import tsx/esm scripts/soak-tui-v2.ts"
}
```

同一实现集合把 `@xterm/headless`、`get-east-asian-width` 和 `tsx` 的 manifest specifier 固定为当前 lockfile 的 exact `6.0.0`、`1.6.0`、`4.23.12`；lockfile 版本、integrity、loader 和 package-manager hash 写入 build artifact。任何脚本若绕过 package script 直接启动 benchmark/soak，也必须显式带 `--expose-gc` 并通过 global.gc fail-fast 检查。

在同一实现集合中更新 `.github/workflows/ci.yml`，加入 Node 22.19/24 matrix 的 compile、`test:tui-v2`、`verify:tui-v2`、package dry-run 和 bounded soak；nightly/release workflow 加入 8/24 小时 soak 及 Windows/macOS/Ubuntu 真实宿主 job。`.github/workflows/publish.yml` 必须在 publish 前重复 `verify:tui-v2`、package tarball/license 检查；任何新命令未被 workflow 调用都不算完成。

最终 gate 还必须运行 `pnpm verify:tui-v2 -- --check ci-integration`：脚本扫描所有 `.github/workflows/*.yml` 的 job/step，确认 Node 22.19/24、test wrapper/custom reporter、verify、bench/soak、`upload-artifact` 和 verified-tarball publish step 均存在，并把 workflow commit/hash、实际命令退出码和 artifact 路径写入 JSON；只修改计划文档或只在本地运行命令不能通过。publish job 必须消费 pack/verify 产生的 exact tgz，任何重新执行 `prepare` 或普通 `npm publish` 命中即阻断。

---

## 12. 回滚、发布与兼容策略

### 12.1 运行时回滚

- 当前包只有一条 v2 bootstrap 路径，不读取 `DSH_TUI_RENDERER`，不提供 v1/v2 运行时选择，也不在同一进程内 fallback。
- renderer 初始化失败时，无论是否已接管终端，都必须先执行 cleanup，再以专用非零退出码结束；不能双写 stdout 或启动第二套 renderer。
- 回滚只由独立 launcher 按不可变 manifest 拉起上一发布包；当前包不携带旧 renderer，也不把离线 baseline 当作 emergency fallback。
- 发布时保留一个已验证的上一版本 rollback artifact、启动命令和兼容的 DSH session schema；故障进程退出后由 launcher 使用该 artifact 恢复 session。
- child-process gate 必须覆盖 `failed-before-takeover`、`failed-after-takeover`、cleanup error、launcher restart、重复 signal、stdin close 和 update restart；记录退出码、raw/alt/mouse/paste/cursor 状态和是否写过 stdout。

回滚 artifact 必须随 release 生成不可变 `rollback-manifest.json`，并由 `verify:package --rollback` 校验：

```json
{
  "schemaVersion": 1,
  "registry": "registry.example.invalid",
  "package": "@scope/dsh-tui",
  "version": "1.2.3",
  "tarball": "@scope-dsh-tui-1.2.3.tgz",
  "sha256": "lowercase-64-hex",
  "signature": { "algorithm": "sigstore|gpg", "ref": "immutable-signature-ref" },
  "sessionSchema": { "min": 1, "max": 1 },
  "launcher": { "command": "dsh-tui-rollback", "args": ["--package", "..."], "timeoutMs": 30000, "retries": 2 },
  "retention": { "keepStableVersions": 1, "expiresAt": "2027-01-01T00:00:00Z" }
}
```

manifest 的 registry、exact version、tarball 文件名、SHA-256、signature/ref、session schema compatibility、launcher command/args、timeout/retry 和 retention 都是必填；registry 不可用、signature/hash 不匹配、版本不满足 session schema 或下载超时重试耗尽时，launcher 必须返回明确非零错误并保留当前进程的 cleanup 证据，不能尝试未知版本。至少保留一个已验证的上一发布包和 manifest；child-process rollback drill 必须从故障 renderer 启动、完成 cleanup、按 manifest 拉起 exact tarball、验证同一 session resume，再记录 stdout ownership、退出码和 terminal mode。该 drill 验证的是外部包切换，不是当前进程的 renderer 选择。

### 12.2 数据兼容

v2 不修改 session log 格式。resume、rewind、fold/loadOlder 使用现有 adapter contract；任何新的 UI preference/trace schema 都采用版本号和向后兼容读取，不能把临时 frame 数据写入 session 真相。

### 12.3 发布前清单

- 生产构建、类型检查、边界 guard、`pnpm test:tui-v2`、`pnpm verify:tui-v2`、bounded soak、双 Node 矩阵和 package dry-run 全部通过；命令必须实际出现在 CI/publish workflow。
- 旧 baseline 与最终 renderer 的离线同 trace 对比报告已审阅，已知差异登记；生产进程没有双跑依赖。
- 真实终端退出和异常恢复手工验证完成。
- README/architecture/rendering/known limitations 已更新。
- pi-tui fork 的 `LICENSE`/`NOTICE` 必须进入 runtime tarball；source commit、每个文件 hash、patch ledger 和 re-vendor 命令随仓库/source release 发布（若 vendored source 进入 tarball则一并进入）。`npm pack --dry-run --json` 与 `scripts/verify-package.mjs` 按这一声明检查文件、导出和没有意外旧依赖。
- 发布必须验证并发布同一个 tarball，固定 shell 流程为：`pnpm compile`; `outDir="${RUNNER_TEMP:-$(node -p "require('os').tmpdir()")}/tui-v2"`; `mkdir -p "$outDir"`; `packJson="$outDir/pack.json"`; `rollbackManifest="$outDir/rollback-manifest.json"`; `npm pack --ignore-scripts --json --pack-destination "$outDir" > "$packJson"`; `tgz=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1])); const x=Array.isArray(r)?r[0]:Object.values(r)[0]; process.stdout.write(require('path').resolve(x.filename))" "$packJson")`; `sha=$(sha256sum "$tgz" | cut -d' ' -f1)`; `node scripts/verify-package.mjs < "$packJson"`（保留当前 stdin-only package surface 检查）；`node scripts/verify-tui-v2-tarball.mjs --tarball "$tgz" --sha256 "$sha" --pack-json "$packJson" --rollback-manifest "$rollbackManifest"`（检查 exact tgz 内容、file manifest、license/NOTICE、exports、依赖和 rollback manifest，并生成 `verified-tarball.json`）；最后 `npm publish "$tgz" --ignore-scripts`。`.github/workflows/publish.yml` 必须消费 `verified-tarball.json` 中的同一绝对路径/hash，不得在验证后执行普通 `npm publish` 或触发第二次 `prepare`/compile；`prepare` 只允许在第一步 build 运行，发布步骤必须带 `--ignore-scripts` 并对 exact `.tgz` 做 registry publish response/hash 记录。`RUNNER_TEMP` 未设置时 wrapper 使用 `os.tmpdir()/tui-v2`，不能把占位符传给 shell。
- 上一发布包/launcher、诊断开关和错误提示在生产环境可用；当前包没有 renderer 回滚开关，诊断只包含 redacted schema，权限/7 天/50 MiB 保留策略通过测试。

---

## 13. 任务分解与完成定义

### 13.1 任务编号

| 编号 | 任务 | 依赖 | 完成定义 |
| --- | --- | --- | --- |
| R-001 | 旧实现离线 baseline、测试 runner、基线脚本和指标 | 无 | `test:tui-v2`/`verify:tui-v2` smoke 可运行，能重复启动/退出，baseline 报告入库且不进入 runtime |
| R-002 | trace schema 和脱敏 writer | R-001 | 核心事件可 JSONL 保存/加载 |
| R-003 | virtual terminal/cell grid | R-002 | ANSI patch 可重建 cursor/modes/grid |
| R-004 | pi-tui source pin/license/patch ledger | R-001 | 上游 commit 和本地差异可追溯 |
| R-005 | v2 terminal profile/writer/lifecycle | R-003,R-004 | 单 writer、backpressure、cleanup 可测 |
| R-006 | Component/Frame/compositor contracts | R-004,R-005 | base+overlay+cursor 合成通过单测 |
| R-007 | scheduler and cache policy | R-005 | 优先级、合并、丢弃、上限有测试 |
| R-008 | UI reducer/state/selectors | R-002 | reducer 纯函数，live/replay 等价 |
| R-009 | ChannelUiAdapter | R-008 | ChatRow/channel/store 转 AppEvent |
| R-010 | walking skeleton | R-005..R-009 | 核心纵向 trace v2 可跑 |
| R-011 | fullscreen transcript/editor | R-010 | sticky scroll、dock、resize、exit 正确 |
| R-012 | dialogs/selection/search/copy | R-011 | overlay layer 无残影且焦点正确 |
| R-013 | inline backend | R-010,R-005 | main-screen 核心 trace 无 scrollback 污染 |
| R-014 | advanced components/scenes | R-011,R-012 | 功能逐项有 contract + trace |
| R-015 | 离线 baseline compare 与最终集成 | R-010..R-014 | 独立 `V1CaptureRenderer`/compare harness 无副作用，同 trace 的 grid/frame/bytes 报告可审阅，生产 bootstrap 只有 v2 |
| R-016 | 一次性删除旧链路与最终包验证 | R-015 | 无旧热路径、React/JSX/Yoga 依赖或 renderer switch，生产包/文档/exports 更新 |

### 13.2 每个任务的完成定义（DoD）

所有任务共有以下条件：

- 代码位于正确的依赖层，未绕过 boundary。
- 没有新增无上限缓存、stdout 写入点或未记录的控制序列。
- 失败路径有 cleanup；异步任务可取消、timer 可释放。
- `git diff` 只包含任务范围，文档和 patch ledger 已同步。

按任务类型增加门槛：

- component/renderer/compositor（R-006、R-010--R-014）：最小单测或 trace 回放、cell/grid 断言，以及 width=0/1/2、CJK/emoji 和相关 profile 边界。
- model/controller/adapter（R-002、R-008、R-009）：canonical state/replay、seq duplicate/gap/reset、异步取消和错误路径测试；不强制无关的宽度用例。
- terminal/scheduler/lifecycle（R-003、R-005、R-007）：virtual terminal、backpressure、profile timeout 和 child-process cleanup/信号测试。
- baseline/benchmark/package/license/guard（R-001、R-004、R-015、R-016）：可重放命令、JSON/报告 schema、Node 矩阵、tarball/导出/license 检查、离线工具隔离和 guard 产物；若触及渲染代码，再叠加 component 门槛。

---

## 14. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| pi-tui fork 与上游漂移 | 修复难以回合 | pin commit、patch ledger、上游测试、禁止整目录覆盖 |
| 功能迁移量大 | 一次性替换遗漏能力 | 用同一依赖图并行完成 walking skeleton、能力矩阵和最终集成；未实现功能在最终 gate 前必须补齐或显式登记为不支持 |
| Channel 现有原位可变 row | revision/cache 不稳定 | bridge 中拍平 snapshot，streaming row 单独处理，settled row immutable |
| plugin 扩展依赖旧 JSX | 生态回归 | 在同一 breaking release 提供迁移文档和 line component/serialized view contract；最终包不保留旧 API |
| Windows/ConPTY capability 不一致 | raw ANSI、宽度、恢复故障 | profile conservative path、真实矩阵、virtual terminal 回归、full redraw fallback |
| 双 renderer 维护成本 | 修复重复 | 生产只保留 v2；旧实现仅作为隔离 offline baseline，不共享 screen algorithm 或运行时依赖 |
| frame 对照器自身错误 | 错误结论 | 使用 @xterm/headless + 独立最小 virtual terminal，抽样真实终端验证 |
| 流式高峰 backpressure | 输入延迟/内存增长 | 优先级 scheduler、丢弃过期低优先级 frame、writer queue 上限和指标 |
| 外部工具/插件越权 stdout | 帧损坏 | 单 writer、console patch、stderr policy、CI allowlist |
| 旧依赖删除遗漏 | 隐性公共 API 或构建产物破坏 | 在同一最终 gate 扫描 exports、插件 fixture、依赖图和 tarball，未通过就不合并 |

---

## 15. 决策记录与待确认项

### 15.1 已锁定

- 默认方向参考 Kimi 的 state/controller/component 分层，但 reducer、immutable snapshot 和 replay 是 dsh-TUI 自己的设计；唯一 source 是 `@earendil-works/pi-tui`（pi `packages/tui`）commit `086c32e74530564922d011ade23ff582c9d63116`（`0.84.2`），Kimi 仅作参考。
- 不使用 OpenTUI React/Solid，不继续扩展 React/Ink/Yoga 热路径。
- fullscreen 是正确性参考和最终首选；inline 独立降级。
- Session log 是真相；UI state 是可回放投影和交互状态。
- 所有 overlay 通过独立 compositor；无法证明局部 patch 安全时 full redraw。
- 所有物理行必须经过最终宽度硬保护。
- pi facade 采用完整 `PiTerminalAdapter` + fork 调用点改造；未知 control sequence 拒绝，唯一 writer 负责背压、query correlation 和 lifecycle。
- `ScreenTakeover` 只接受 coordinator 签发的 opaque token，必须先取得 writer barrier 再转移 stdin/tty；scene v2 使用 versioned descriptor/typed command，旧 React scene 只存在于独立离线 baseline，不进入最终 adapter/runtime。
- golden 统一 `CanonicalGridV1`/`readable|sha256-v1`，性能窗口、`--expose-gc` 和 rollback manifest 均为机器校验的发布门槛。
- WP-01 落地时扩展 regression matrix 的 `disposition` 枚举，新增 `unaffected` 取值（原为 `rewrite-v2 | remove | offline-baseline`）。原因：原枚举无法表达「该回归入口不触及被迁移的渲染/插件面，原样保留并由 CI 持续证明」（如 `verify-model-route`、`verify-session-index`、cordis patch/plugin 契约校验等纯逻辑入口），强制归入 `rewrite-v2` 会虚报迁移工作量。影响：`verify:tui-v2 -- --check regression-matrix` 接受该值；`unaffected` 行 `blockDefault: false`，在最终 gate 视为关闭的条件是其 `ciCommand` 在最终树中仍存在且通过；入口一旦被移除，对应行必须同时删除（清单重扫 hash 会强制同步）。回滚方式：删除该取值、把 `unaffected` 行重新分类为 `rewrite-v2`/`remove` 并同步更新校验脚本枚举。
- WP-02 落地时明确两条 testkit 边界。其一：§6.1 的「tabstop 固定为 3」只约束产品逻辑宽度管线（组件→compositor 的 wrap/truncate）；`testkit/virtual-terminal.ts` 作为字节流终端模拟器按 xterm/真实终端惯例用 tabstop 8，两者属于不同层，不构成同一管线的双重标准。其二：golden 文件的 `input` 用 steps 数组（write/resize 步骤）而非单一字节串，因为 resize 无法用字节流表达；`expected` 的 `GoldenGrid` 编码（`readable`/`sha256-v1`）不变。影响：仅 testkit 内部表示，产品宽度管线仍在 §6.1 约束下实现并在 WP-03+ 用 conformance fixture 验证。回滚方式：testkit 改回 tabstop 3 / 单字节串并重新生成 golden。
- WP-04 落地时核实（`grep -rn DSH_TUI_RENDERER src/ scripts/ docs/`）：`DSH_TUI_RENDERER` 环境变量选择逻辑在仓库源码/脚本中从未存在，仅本文档的前瞻条款提及，因此 WP-09 的「删除 v1/v2 运行时选择」落实为「不引入」——v2 bootstrap（`src/tui-v2/app/bootstrap.ts`）不提供任何 renderer 选择开关，v1 入口的切换与旧路径拆除全部留给 WP-09。原因：walking skeleton 阶段引入选择开关会把未完成的 v2 暴露给生产入口，且双路径并发运行违反单一 writer 原则。影响：WP-09 之前的生产行为零变化；v2 只能经测试/verify/离线 compare 触达。回滚方式：无需回滚（无代码被删除）；若最终确实需要切换开关，在 WP-09 按 §5 设计新增并同步本文。
- WP-05b 落地时锁定 dialog overlay 的 focus/capture 优先级。跨类型顺序逐字沿用旧 `src/screens/Chat.tsx` 底部 chrome 渲染三元组（approval 面板 > 托管插件 dialog > question 问卷 > prompt）：approval=300、plugin-dialog=200、question=100。`DialogsController` 在 store 之间仲裁：任一时刻栈上至多一个受管 dialog overlay（最高优先级的 pending snapshot）；低优先级 snapshot 到达时留在各自 store 队列中等待，高优先级 snapshot 到达时抢占——关闭当前 overlay（底层 ask 仍停在 store 里，不算 settle）并打开胜者；胜者 settle 后补开次优先 pending。这精确复现旧面板替换行为（store 队列才是真相，overlay 只是视图）。抢占重开重置交互状态（focusIndex/checked/text），等同旧面板按 `key` remount 的语义。焦点回落链（close → 栈内下一个 capturing overlay → editor）沿用 reducer 的 `applyOverlayClose` 语义；单一 store 内队列 FIFO 且 key 稳定，因此「最新到达的 capturing dialog 置顶」这条兜底规则在受管 dialog 之间实际不会触发，它只对同优先级并列（不存在）或外来 overlay（WP-06+，reducer 默认语义）生效。原因：旧代码对跨类型顺序有明确规定，优先沿用；reducer 不引入焦点优先级概念，仲裁留在 controller（§4.3 model 不感知业务优先级）。影响：`src/tui-v2/controllers/dialogs.ts` 的 `DIALOG_PRIORITY` 与仲裁注释；组件只读 payload。插件 dialog 超时仍由 `TuiDialogStore` 自有 timer 承担，controller 不持有任何 timer，`dispose()` 语义即「退订 + 失效」（coordinator stop 时 UiState 整体拆除，不再补发 close）。最小输入降级登记 WP-08：单行 input 只支持尾部 append/backspace（光标移动/删除键全量编辑）、question 的 `intent`（plan-review）呈现、选项旁的自定义输入行、空 multi-select 提交的内联错误文案、问卷完成批次的 transcript 摘要折叠（`takeSummaries` → `pushLocal`）均在 WP-08 补全——v2 尚未接线生产入口，无用户可见回归。回滚方式：删除 `DIALOG_PRIORITY` 仲裁改为纯到达序（reducer 默认），或按 WP-08 全量组件重写 panels。
- WP-06a 落地时锁定 Frame cell 化的四个实现决策。其一：WP-04 的 `app/lines-frame.ts` 桥按其头注约定删除，由 `renderer/cells.ts`（信任边界 API + `ResourceTable` 内容键 interning + `fitCellsToWidth`）与 `renderer/frame-builder.ts`（完整 Frame 装配 + 行不变量断言 + deep-freeze）取代，`app/coordinator.ts` 直接经 `buildFrame` 产出 Frame。其二：WP-04 登记的「lines.ts SGR 重放编码器统一到 writer 侧」偏差关闭——`terminal/ansi.ts` `encodeCells` 是 cell→terminal 字节的唯一编码器（SGR/OSC 8 从 StyleDescriptor/HyperlinkDescriptor 编码）；`sgrForLineStyle`/`cellsToString` 保留为组件侧逻辑行 builder，其产出字符串不直接写 tty，一律由 frame-builder 重解析为 cell。其三：`ResourceTable` interning 时把颜色归一化为 testkit canonical 拼写（named/bright→`ansi16:<n>`、`ansi256:<n<16>`→`ansi16:<n>`、`#rrggbb`→小写 `rgb:rrggbb`），writer 字节完全不变（`red` 与 `ansi16:1` 都编码为 SGR 31），但 frame resources 由此可与 VirtualTerminal canonical grid 直接 `compareGrid`（VT 把命名色规范为 `ansi16`、truecolor 规范为 `rgb:`），且语义等价样式去重为同一 id。其四：`fitCellsToWidth` 对超宽/右缘跨界宽 grapheme 采用 §5.5 允许的「裁剪」（整体丢弃后以默认样式空格补齐），不使用 lines.ts 字符串重放侧的 `OVERWIDE_SUBSTITUTE` 空串替代 cell——frame 行每个 cell 必须对应一个真实终端列，width-1 空 grapheme cell 会让 `encodeCells` 少发字节导致终端光标与 grid 失同步。另登记两条现状约定：逻辑行管线的 OSC 8 只透传 uri（params 在 tokenize 时丢弃，WP-04 起如此；`ResourceTable.internHyperlink(uri, params?)` 已为 compositor 直填预留）；xterm/VT oracle 以 underline 属性表示 OSC 8 链接 cell，组件输出链接文本须自带 SGR 4（WP-06b 组件落地时遵守）。原因：§5.5/§6.1 要求 frame 在 compositor/diff 前完全 cell 化且与 golden/VT 可比较，上述四点是不改变 writer 字节前提下满足可比较性的最小实现。影响：新增 `src/tui-v2/renderer/cells.ts`、`src/tui-v2/renderer/frame-builder.ts`，删除 `src/tui-v2/app/lines-frame.ts`；lines.ts 仅抽出 `tokensToCells`（`lineToCells` 行为不变）；测试 `renderer-cells-width.test.ts`/`frame-builder-fullscreen.test.ts` 覆盖宽度矩阵、continuation 不变量、资源 id 稳定性、untrusted strip、freeze 与 patch/VT 双重对照。回滚方式：恢复 `lines-frame.ts` 并回退 coordinator 调用点；删除两个新 renderer 模块与测试；canonical 拼写归一化删除后 frame 与 VT 的比较需改回拼写归一化前置（不建议）。
- WP-06b 落地时锁定 compositor + fullscreen backend（TuiAltScreen）的九个实现决策。其一：合成序固定为 base → overlay 栈（back→front，z=i+1 带 clip）→ selection/search highlight（z=1000+i）→ cursor 透传；`renderer/compositor.ts` 是纯函数，`previous` 帧只用于 affectedRegions/changedRows 元数据，绝不作 cell 源——overlay 关闭后的显露区一律由本帧 base 重绘（关闭残影测试以两帧 patch replay 证明）。其二：`resolveOverlayRect` 逐一对齐 vendored pi `resolveOverlayLayout` 语义（margin 内嵌、width/maxHeight/minWidth 支持 number 或 `%`（基数为帧宽/高）、row/col 绝对或 slack 百分比、anchor、offset、clamp），两处有意的差异：所有坐标取整（cell 网格没有亚行）、height clamp 到可用高度（pi 让超高 overlay 溢出靠行索引裁剪，cell 网格改为钳制）。其三：overlay 内容经注入的 `renderOverlay` 桥（`components/overlays/render-dialog.ts`：approval/question/plugin 三个最小组件，未知 payload 返回空）产出信任逻辑行，再统一过 §6.1 cell 管线 + `fitCellsToWidth`；blit 时对 rect 边缘做宽字符 healing（覆盖到宽字符一半时另一半补默认样式空格）；base cell 经 resolved 内容 re-intern 到新 ResourceTable，绝不跨帧借 id。无 overlay 无 highlight 时 compositeFrame 原样返回 base（identity，WP-06a 字节等价路径不变）。其四：fullscreen backend 的跨帧 cell 比较解析各自帧的 resources 按内容比较，不复用 pi fork `screen-plan` 的 styleId 相等快捷路径——该简化在 fork 路径保留不动（id 别名回归测试覆盖），新后端不走这条隐患路。其五：resize 事务的原子性 = 单个 patch 内先 erase（按新几何边界）再逐行整行重写，经单一 writer batch 落盘；不引入 BSU/ESU 逐帧包裹（kitty-sync profile 的 sync output 仍由 writer 既有编排负责）。其六：fullscreen backend 的 start/stop 只是 generation 闸门与 patchSeq 谱系（按 generation 重启），不发任何字节——alt screen 进出字节归 lifecycle 既有编排（§6.4）。其七：全量重绘触发点映射锁定为 initial（首帧）/ SIGWINCH resize 事务（'resize'）/ SIGCONT（'resume'）/ Ctrl+L（'damage'——`FrameMetadata.fullRedrawReason` 没有 user 取值，用户主动刷新归入 damage）/ app/error（'cleanup'，当前接线下 exit render 通常被 stop 屏障取消，该标记供 takeover/restore 路径使用）/ reducer 无因 needsFullRedraw（'unknown-mode' 默认）；另修复 WP-04 接线隐患：writer 报告 stale/dropped 时 previousFrame 作废并强制下一帧 'damage' 全量重绘（原先未落盘却仍记录 previousFrame，后续增量 patch 会建立在终端从未收到的帧上）。其八：凡 patch 含 cell/erase op 必重发 cursor op（否则物理光标停在最后写入处）；mode ops 仅在值变化时发且会话首帧不发（lifecycle 已物理建立）；resources op 永远是 patch 第一个 op。其九：selection/search 高亮是骨架状态——compositor 接受可选 `highlights` 输入（cell rect + style，绘于 overlay 栈之上，§6.3），缺省/空为 no-op；model 尚无 selection/search state，完整生产者随 WP-06c/WP-08 落地。原因：§6.3/§6.4 要求 overlay 合成与 fullscreen patch 可证明安全（affectedRegions 只含合成器 damage，base damage 由 diff 精确处理；continuation cell 绝不单独更新——span 端点按 next frame 做 continuation 安全扩展），上述九点是在不动 writer/lifecycle/pi fork 前提下满足该要求的最小实现。影响：新增 `src/tui-v2/renderer/compositor.ts`、`src/tui-v2/renderer/diff-planner.ts`、`src/tui-v2/terminal/fullscreen-backend.ts`、`src/tui-v2/components/overlays/render-dialog.ts`；coordinator renderOnce 改为 buildFrame → compositeFrame → backend.plan；fullscreen 模式（profile `supportsAlternateScreen === 'yes'` 的默认路径）经 FullscreenBackend，inline 保持 PiTuiMainScreenBackend 纯 planner；`FrameMetadata.fullRedrawReason` 扩为 `initial|resize|resume|damage|unknown-mode|cleanup`（frame.ts 内联联合）；CoordinatorDiagnostics 新增 `lastFrameFullRedraw(Reason)`。测试 `compositor.test.ts`（布局矩阵/嵌套/非捕获/不可见/关闭无残影/下方内容取自本帧 base/宽字符 healing/affectedRegions 开-变-移-关/highlight 骨架/freeze/几何不匹配强制 fullRedraw/dialog 桥）、`fullscreen-backend.test.ts`（capabilities 双端断言、span diff、id 别名回归、宽字符序列、cursor 重断言、mode ops、generation/patchSeq、resize erase+重写、四种 reason、VT 字节对照、mulberry32 fuzz 逐帧 full-render vs patch replay compareGrid）、`fullscreen-triggers.test.ts`（initial/Ctrl+L/resize/SIGCONT 触发链 + overlay 端到端开闭无残影）。回滚方式：coordinator renderOnce 改回 buildFrame 直出 + PiTuiMainScreenBackend；删除四个新模块与三个测试文件；`FrameMetadata.fullRedrawReason` 收回 WP-04 枚举（writer stale 隐患随之恢复，需单独评估）。
- WP-06c 落地时补齐 base viewport 三个缺口并锁定基本内容组件的六项决策。缺口补齐（base-renderer.ts）：其一，session epoch reset 且 viewport 非 sticky 时若存在 live anchor，原先静默落底、无诊断——现按 §6.2 记入 `anchorFallbacks` 诊断并在同帧应用明确的 `anchorFallback` top/bottom 策略（sticky 时 anchor 本就不驱动滚动，静默丢弃不算 fallback）；原先 scroll 计算里 `anchor.sessionEpoch !== input.sessionEpoch` 的死分支随之删除（epoch 变更点已清 anchor，不变量：live anchor 必持当前 epoch）。其二，model 提供的行窗超过 600 行硬上限时原固定取尾部 600 行——若非 sticky 且 anchor 行仍在所给窗口内，测量切片改为以 anchor 为中心（clamp 到窗口界），使超窗锚定可恢复；无 anchor 或 sticky 时保持尾部偏置（follow-end），窗口外行只经 `loadOlderRange` 分页取回，绝不整 transcript 复制进 frame。其三，`loadOlderRange` 页大小基数由 `visibleRows.length` 改为最近一次 render 的 transcript viewport 高度（§6.2 overscan = max(2*viewportHeight, 64)），首次/退化 render 前回退到窗口长度保持确定性。缓存键审计结论：render/height 缓存键已含完整 (sessionEpoch,rowId,revision,width,theme,profile)（`rowCacheKey`），width/theme/profile transaction 清理（`applyEnvironmentChange`+声明式 policy）已在 WP-04b 就位，本次仅补 theme/profile 变更的测试。基本内容组件决策（components/transcript/markdown.ts、code.ts、diff.ts，tool-row.ts 卡片化）：其一，markdown 为逐行块级解析（标题/段落不并行/列表/引用/fence/表格逐字退化），行内 span 只支持 `` `code` ``、`**bold**`、`*italic*`（开界符后不得跟空白，`2 * 3 * 4` 保持字面）、`[text](url)`；段落并行、`_` 斜体、嵌套强调、`~~~` fence、setext 标题、hr、引用链接、表格对齐均为 WP-08 差距。其二，链接仅当 `profile.supportsOsc8Hyperlinks === 'yes'` 且 scheme 为 http(s)/mailto 时发 OSC 8（uri 取自 sanitize 后文本，ESC/BEL 不可达），链接文本自带 SGR 4（WP-06a 15.1 约定）并用 theme 新增 `link` role；否则退化为纯文本 `text (url)`。其三，code 与 diff 逻辑行一律裁剪不折行（wrap 会破坏等宽对齐与前缀语义），跨界宽 grapheme 由 `truncateCells` 整体丢弃；语言徽标行（`showLanguage`）与语法高亮留 WP-08，```diff fence 路由到 diff.ts。其四，diff.ts 输入为 unified diff 文本（+/−/context/hunk/header 着色，可选新文件行号 gutter，右对齐、删除行空 gutter）；tool 卡片把结构化 `{path, oldText, newText}[]` 合成为 unified 文本（多文件带 `--- a/x`/`+++ b/x` 头、同文件 hunk 间插 `@@`）再交 diff.ts 渲染，`⋯` 同文件分隔符留 WP-08。其五，tool card body = `resultView ?? callView`（对齐旧 `AssistantToolUseMessage.tsx`）：diff/terminal/read/generic/search 五种卡片 + 字符串/数组/未知形状文本退化；文本类 body cap 3 行、diff cap 8 行（CHAT_DIFF_MAX_LINES），折叠提示 `… +N lines`（verbose/ctrl+o 展开留 WP-08）；body 首行 gutter ` ⎿ `、续行 `   `（修正 WP-04b 每行都带 ` ⎿ ` 的偏差）；running 阶段保持无 body（pending diff 预览留 WP-08）；无 summary 文本块时 header 回退到 view 的 `title`。其六，assistant-message 的 markdown 块改经 markdown.ts 渲染（`● ` bullet 仍只挂首个输出行），text 块改为逐行悬挂（修复 WP-04b 多行 text 经 lineToCells 静默并行的缺陷；projection 不为 assistant 产 text 块，goldens 不含 assistant 行，无可见回归）。原因：§6.2 要求 anchor 不可恢复（reset epoch/eviction/resize）时退回明确策略并记录诊断，且超上限内容只能分页；基本组件需在不 import 旧 React 代码前提下覆盖 WP-06 清单的 Markdown/代码/diff/tool card。影响：`renderer/base-renderer.ts`（三处行为补齐 + 头注）、`components/theme.ts`（新增 `link` role）、`components/transcript/`（新增 markdown/code/diff 三个模块，assistant-message/tool-row 重写 body 路径）；测试 `base-renderer.test.ts`（scroll/缓存事务新增 4 例）、`components-content.test.ts`（17 例：逻辑行断言 + buildFrame→canonical grid 快照 + 宽度矩阵）、`components-transcript.test.ts`（tool card 新增 7 例）；既有 32 例 transcript/base-renderer 测试逐字不回退。回滚方式：恢复 base-renderer 三处改为 WP-04b 行为（静默 anchor 丢弃、尾部偏置、窗口长度基数）；assistant-message/tool-row 恢复原文件；删除三个新组件模块与新测试。
- WP-06d 落地时锁定 fullscreen 端到端验证（`--check fullscreen` + `fullscreen-overlay-scan.test.ts`，共享 `test/tui-v2/helpers/fullscreen-harness.ts`）的五条约定。其一：harness 的 modes 快照恒定取 VT 初始等价值，`scrollRegion` 固定为初始几何 {0, h-1}、从不随帧变化——DECSTBM 会把光标 home 到 (0,0)，而 production lifecycle 的 mode 快照用静态 profile.rows、从不发 DECSTBM；VT 在 resize 时自行把 scrollRegion re-clamp 到新高度，凡与 VT snapshot 比较的字节路径期望一律从 VT 投影该字段（唯一被投影的 mode），frame 侧不发对应 mode op。其二：golden 管线复现（half B）只做三条已登记 projection——oracle 未写 blank（grapheme `''`）在 v2 cell 网格物化为默认样式空格、scrollback 经 alt-screen patch 不可达（由 `evaluateGoldenFile` 的 oracle half A 覆盖）、`modes.title` 仅当 golden 非 null 时投影（首帧 fullscreen patch 无 title op，title 属 lifecycle/OSC 域）。其三：hyperlink cell 的终端缓冲约定——xterm/VirtualTerminal 以 underline 属性表示 OSC 8 链接 cell（`virtual-terminal.ts` printGrapheme 对齐注释），v2 frame model 保持 hyperlink/underline 独立（生产组件按 WP-06a 约定自带 SGR 4，harness 构造的裸 OSC 8 行没有）；凡与 VT snapshot 比较的预期网格都把 `hyperlink ≠ null` 的 cell 投影为 `underline: true`。冒烟暴露的两处失配（此条与 scrollRegion re-clamp）均为 harness 投影缺口，非 v2 cell 级缺陷、非 golden 语义问题，无 golden 改动。其四：trace fixture 的 overlay payload 已脱敏（`{kind:"<redacted:text …>"}`），`renderDialogOverlayLines` 对其返回空行，故 overlay 内容级覆盖由程序化 `payload.lines` 的 no-ghosting 扫描承担（center/edge anchor、百分比尺寸、两层嵌套、open→move→resize→close 全程显露区逐 cell 等于从未开过 overlay 的 base）。其五：§9.3 P0/P1 台账机器化（check Part 4）：每条映射到可解析的 fixture/test/check 引用，四条 deferred 登记——inline scrollback 增量与第三方 stdout/stderr 归 WP-07，external editor 暂停/恢复与 plugin component 抛错归 WP-08；deferred 不 fail，其余条目引用不可解析即 fail。回滚方式：删除 `--check fullscreen`、harness 与测试文件，台账回到人工核对。
- WP-07 落地时锁定 inline/main-screen backend 的十个实现决策。其一：帧契约新增两个 PatchOperation——`append`（CR + cells + 可选 LF，无 CUP，仅 initial paint 使用）与 `line-feed`（CUP(y+1,1) 后发 count 个 LF，是 inline 唯一产生 scrollback 的原语）；`FrameMetadata` 新增可选 `inline: { liveStart, followEnd }` hint，`liveStart` 把帧切成 settled 前缀（只许进 scrollback、绝不原地改）与 live region（streaming 行/unseen indicator/整个 dock，原地重绘），`followEnd` 只在「本帧钉在内容尾且上一帧也是」时为真，防止 pageUp→pageDown 把旧内容重复喂入 scrollback；hint 由 `app/inline-live-region.ts` 的纯函数 `computeInlineLiveRegion` 产出，coordinator 与 inline harness 共用同一实现（保守方向：存疑即扩大 live region）。其二：不变量 frame = screen——inline 帧即全视口，物理屏逐行镜像帧；首帧（`fullRedrawReason==='initial'`，必须按 reason 分流而非 `previous===null`，后者与 resize/damage 重置歧义）以 append 从当前光标行涂满 H 行，shell 原有内容上推入行 scrollback（可接受，已登记）。其三：append 增量配方——仅在双方 hint 齐备且双方 followEnd 时启用：k 在 `[max(0,ps-ns)..ps)` 内升序取第一个无缝前缀（`next[i]==prev[i+k]`，`k===ps` 永不选取，全滚不如重锚；重复内容宁少滚）；若被滚出的前 k 行全为空白 pad 则拒绝滚动改原地重绘（空白入 scrollback 是纯噪声）；命中后发 `line-feed` + 恒写新 settled 行 `[ps-k..ns)` + live region `[ns..H)` 逐行 diff——注意滚动后物理行 y 的内容是 prev[y+k]，diff 源必须随之平移（落地冒烟即靠 VT 回放抓到此处曾错用 prev[y]）；否则整帧逐行 diff 原地重绘。其四：重锚（非 initial 的 full redraw）= 单个 patch 内先 erase（**用 NEXT 帧几何**，canonical erase 越界即 fail，终端 resize 已裁剪）再全行 write-cells；永不发 ED 2/3、DECSTBM 或 scroll op。其五：overlay 降级反馈形式——`supportsNestedOverlay===false` 时传 `overlayStack=[]` 给 compositor（帧管线本身不按 mode 分支），每个新可见 overlayId 经 dock 通知行发一次 warning（append-only 通道，文案 "Inline mode cannot render overlay dialogs; the dialog is hidden and keys still apply"）+ `overlay/unsupported` 诊断，栈空重臂；overlay 在 state 里完整保留，键盘焦点路由不变（不可见但可用）。其六：第三方输出——`terminal/foreign-output.ts` 的 `createForeignOutputGuard` monkey-patch 底层 stream.write（writer 经 Proxy 写入时置 inWriter 豁免；detach 恢复原 write 或 delete，且只在仍指向 patchedWrite 时动手），外来字节只计数并回调，coordinator 转为 `output/foreign` 诊断 + 下一帧 damage 重锚；重锚本身不喂 scrollback。其七：安全退出 park + writer 契约变更——`InlineBackend.planExitPark(generation)` 在已画过帧且 generation 未过期时产出 `[line-feed 一行, cursor(0, H-1, visible)]`（patchSeq 续上帧谱系，writer watermark 合法），让 shell prompt 落在帧下方；writer cleanup bundle 的 `resetScrollRegion()`（CSI r）按 xterm 语义会把光标 home 到 (0,0) 毁掉 park，故 `TerminalWriter.stop` 新增 `preserveCursor?: boolean`，lifecycle 在 `preserveScreen || !alternateScreen` 时传入（inline 恒 true；fullscreen 正常退出仍 false 保持旧行为，1049 恢复主屏光标本就不受影响）。其八：复用禁令的遵守方式——`InlineBackend` 不 import fullscreen-backend，`resourceKeys`/`cellsEqual`/`rowsEqual` 为独立实现（头注声明），只共享 backend contract（frame.ts）、`decidePatchShape`/mode/cursor op 辅助（diff-planner）与编码器（writer）；image placement 直接 RangeError（inline 措辞）。其九：harness/canonical replay 语义——`frame-assert.ts` 的 canonical 回放为两新 op 镜像 VT 语义（LF 在 scroll region 底上滚，全高主屏区域把顶行推入 scrollback；append 行内续列校验 + healAroundWrite），inline harness 的期望投影新增两条已登记约定：canonical grid 在 resize 时手动 re-clamp scrollRegion 到当前高度（镜像 VT 行为），VT 侧 scrollback 行经 crop/pad 投影 + `vtBufferConventionDeep` 扩展 hyperlink→underline 到 scrollback 行；每帧断言 scrollback 增长 === patch 内 line-feed count、旧 scrollback 是新 scrollback 的严格前缀、新增行恰为上帧顶部行。其十：另修复 WP-04/WP-06 接线隐患（先例见 WP-06b 其七）——reducer 的 `terminal.needsFullRedraw` 此前无人消费（置 true 后永不复位），coordinator 与两个 harness 每事件读到它就强制全量重绘，等于首帧后逐帧 full redraw；现改为 consume-on-read（applyEvent 读到即清，同步无竞态），触发点映射（initial/resize/resume/damage/cleanup/unknown-mode）不变，fullscreen differential 与 walking-skeleton 全绿回归。已知差距（登记于 `docs/tui-v2/support-matrix.md`，不伪装 parity）：tall-stream gap（单 streaming 行高于视口时 liveStart=0，中段 settle 前不进 scrollback，宁缺勿滥）、单帧爆增 gap（一帧增长超视口直接重锚，中间行不归档）、overlay 不可见但吃键。支持矩阵机器块由 `--check inline` Part 4 逐字段对账 `INLINE_/FULLSCREEN_CAPABILITIES`，两模式取值不同必须带非空 note；§9.3 台账的 `inline-scrollback-incremental` 与 `third-party-stdout` 两条 deferred 关闭，covers 指向 inline-scrollback trace、三个 inline 测试文件与 `--check inline`。回滚方式：删除 `--check inline`、inline harness 与三个测试文件、`InlineBackend`/`foreign-output`/`inline-live-region` 三模块、coordinator 的 inline 分支恢复为 pi main-screen 桥（台账回到 deferred），两新 PatchOperation 与 preserveCursor 参数随 writer/frame 契约回退。

- WP-08a 落地时锁定 SceneV2 契约与插件 scene 运行时迁移的十个实现决策。其一：§7.4 契约逐字落在 `src/tui-v2/scenes/contract.ts`（SceneCommand/SceneCapabilityContext/SceneV2/SceneComponentAdapter/SceneDescriptorV2/SceneCommandDescriptor/SceneRegistration/SceneRegistrationHandle/TuiSceneRuntimeV2Contract/ToolRowView/PluginRowView），运行时锚为 `SCENE_API_VERSION='2'` 与 `SUPPORTED_SCENE_API_VERSIONS`；分层固定为「Cordis-free 纯运行时（`scenes/runtime.ts`）+ Cordis 门面（`src/dsh-adapter/scenes.ts`）」——门面只做 caller/activation/verified-identity/效果台账解析，运行时只做注册门禁、capability 铸造、会话与 error boundary，coordinator 经 `attach(hooks)` 驱动。其二：最小 ScreenTakeover（`src/tui-v2/terminal/takeover.ts`）——scene 带内渲染，request 取真 writer barrier（quiesce）后**立即 resume**，不挂起 writer、不做 stdin/tty transfer、不重放 mode snapshot；restore 按 token 对象同一性校验（错 token 返回 rejected promise、绝不释放别人 lease，因 §7.4「同一 promise」恒等要求 restore 不能是 async fn——async 会包新 promise 对象；违约路径同步 throw 会破坏 coordinator，故折中为 rejected promise）、同 token 重复 restore 返回同一 promise、restore 只做 generation++ + onRestore（全量重绘标记）。完整 §6.6 takeover（挂起 writer、tty transfer、mode 回放）随 external-editor/update（WP-08 第 6 项）落地。其三：model 三事件 `scene/open{scene:SceneViewModel}` / `scene/close{sceneId,reason}` / `scene/focus{sceneId,target}` + focus 回落链（top capturing overlay → scene → editor）；scene 在 rows-reset（/new、/resume、rewind）后存活（对齐旧 pluginScene 语义），canonical 投影含 scene。其四：error boundary 五个抛错点（factory/render/handleInput/dispatch/onClose）→ 带 `{pluginId,instanceId,sceneId,phase}` 的 `app/error`（code `PLUGIN_SCENE_ERROR`，recoverable）→ 永久 revoke（capability 此后惰性，重开必须 dispose 旧注册再重新 register——revoked record 仍占用 id，未 dispose 的重注册按 duplicate-scene 拒绝）→ takeover restore 恢复前一层；onClose 抛错只上报不中断关闭。其五：注册门禁顺序——apiVersion !== '2' 先落 `unsupported-scene-api`（旧 React descriptor 的自然归宿，结构化拒绝不抛错）；形状违例（id kebab、commands 数组、commandId 非空去重、schemaVersion 非负整数、validate/create 是函数）抛 TypeError（与 validateAppEvent 同一约定：形状是程序错误，结构化结果只承载运行时处置）；duplicate → `duplicate-scene`；grant fail-closed（无 store、deny、store 抛异常同罪）→ `missing-grant`。其六：合法 dispatch 的 payload 整体成为下一个 `view.data`（revision+1，重发 scene/open upsert）；focus 命令转 scene/focus 事件；close 命令走正常 close。其七：inline 模式下 scene 帧走当前 backend 的整屏帧路径（frame-builder 自动补空行/截行，inlineHint 跳过），旧链「inline 下包 AlternateScreen」的形态随 WP-09 入口切换一并处理，WP-08a 不登记等价义务。其八：cordis 的 `dsh-tui-scenes` 行折叠进 `dsh-tui-extensions`（apply 里 `ctx.plugin(TuiSceneRuntime)`），包导出删 `./scenes`/`./jsx-runtime`、新增 `./tui-v2`（仅契约类型 + 两个运行时锚，无 vendor/Frame/writer/ANSI）；旧 patch（仍带 dsh-tui-scenes 行）指向已删除导出属 launcher 层 skew——plugin.ts 的独立 tuiScenes skew guard 随之删除并入 extensions guard 文案。其九：Chat/channel 的 React scene 渲染路径（channel.pluginScene/openPluginScene/closePluginScene + Chat 的 PluginSceneBoundary early-return 块 + plugin-scene-crashed i18n key）整体删除；`PluginSceneBoundary` 组件文件与 REG-066 脚本保留到 WP-09 随旧 renderer 一并清理。过渡期状态：生产入口未切 v2，插件 `open()` 在未 attach 时返回 false + 诊断（plugins.md 已如实登记）。其十：row renderer 注册路径 `registerRowRenderer(renderer, identity)`（每 pluginId 一个，duplicate 拒绝返回 inert dispose），渲染时 `ToolRowView`（row.tool 存在）否则 `PluginRowView`（pluginId 取 row.sourceId，单块 data 取 [0]、多块展开为数组）；渲染器抛错/畸形输出回退宿主默认行渲染（`fallbackRowComponent` 导出化），绝不破坏主 frame。原因：§7.4 要求最终插件面为版本化 capability 契约且 React/Channel/writer/stdout 全不可达；上述分层与门禁顺序是让「旧描述符结构化拒绝 + 新描述符最小迁移」同时成立的最小实现。影响：新增 `src/tui-v2/scenes/{contract,adapter,runtime,row-component}.ts`、`src/tui-v2/terminal/takeover.ts`、`src/tui-v2/index.ts`；删除 `src/scenes.ts`、`src/jsx-runtime.ts`；channel.ts/Chat.tsx/plugin.ts/extensions.ts 迁移；`test/tui-v2/scenes.test.ts`（注册矩阵/dispatch 门禁/五抛错点/close 幂等/takeover/adapter/导出面）与 `test/tui-v2/scenes-coordinator.test.ts`（两 profile 的整屏接管/输入归属/恢复/error boundary/teardown）锁定行为。回滚方式：整包回退本 WP 的文件集合（契约是纯新增模块，门面/exports/yml 为机械替换）；scene 三事件在 model 中为叠加字段，删除即回到 WP-07 语义。
- WP-08b 落地时锁定 Markdown/code/diff/tool card 完整化的八项决策。其一，依赖审计结论为不新增依赖：仓库已有 `marked`、`cli-highlight`、`highlight.js`，但分别绑定旧 React token、异步 ANSI 或 HTML 输出路径，无法直接满足 v2 同步确定性 `LineCell`/信任边界；`code.ts` 因此使用本地最小状态 lexer，固定支持 ts/js/py/bash/json 及常见 alias，token 类仅 keyword/string/comment/number，未知语言退化为统一 code role；diff/patch info 则同步路由到专用 `diff.ts`。其二，fence info string 允许空格并以首 token 选语言；语言徽标默认关闭，只有 `showLanguage:true` 显式请求时显示规范化首 token，避免高亮默认增加 transcript 行高。其三，WP-06c 登记的 soft-line 段落合并、`_` 斜体、混合嵌套强调、`~~~` fence、setext、thematic break、reference link、表格对齐、语法高亮差距全部关闭；未闭合 fence/强调按流式规则输出已收行/字面 delimiter。表格所有测量、分配、左右/居中 padding 与窄宽截断均基于 §6.1 cells；连一列一 cell 加 separator 都放不下时保留源行并 cell-safe clip。其四，code/diff 继续坚持一 source line 一 terminal row、只裁剪不折行；diff 对连续删除/增加 block 按行配对，以有界 token LCS 标记 changed run（病理长行退化为整行 changed），同文件后续 hunk 固定 `⋯`。其五，side-by-side 自动阈值固定为组件总宽 `110` 列；达到阈值时 old/new pane + 单列 divider，低于阈值（包括显式 split 请求）统一降级 unified；`lineNumbers:true` 也保持 unified，避免虚构双侧行号。其六，tool 展开状态只存在于不可变 `TranscriptRowView` 的 `verbose/expanded/footnote` 字段，组件无可变交互副作用；verbose 解除 text=3/diff=8 cap，恰好多一行时直接展示而不制造 hint，footnote 永远在 cap 外，running 优先预览 `callView` pending diff，无 preview 时显示确定性 `Running…`。错误卡固定展示 message/code/recoverable/details；整卡前景样式与 `toolBackground`/`toolBackgroundExpanded` 合并并 pad 到 viewport，实现真实行级背景。其七，版本化 `markdown-tool-rendering@v1` trace 同场覆盖复杂 Markdown、120 列 pending/settled diff、长输出折叠和错误；generator 只对该场景保留受控 `[placeholder]` 文本及 `markdown/text/diff/terminal` discriminant，其余 payload 继续默认 hash redaction，重新生成证明既有 20 个 trace 字节不变。回归矩阵 REG-010/REG-020 转 verified，旧 React repro 留到 WP-09 删除。其八，保留差异明确为：raw HTML 不执行而按不受信任文本处理；Markdown 图片仍归 WP-08 第 5 项；本地解析器只承诺本工作项列出的 transcript 语法，不声称逐边角 CommonMark conformance（同 delimiter 三连等歧义保持确定性字面降级）。回滚方式：恢复 WP-06c 四个基本组件与 20-trace 清单、删除新增 theme/ViewModel 字段和 fixture，并把 REG-010/020 恢复 open；无需回滚 lockfile。
- WP-08c 落地时锁定交互 overlay 的十二项决策。其一，approval/question/plugin dialog 与通用 picker/help/history/transcript-search 全部迁移为纯 line component；组件只接收 model 层严格解析的可序列化 payload，所有不可信文本重走 sanitize→grapheme/cell→wrap/truncate 管线，任何组件都不导入 dsh-adapter/Cordis。其二，业务 dialog 固定优先级继续为 approval=300 > plugin-dialog=200 > question=100，`TuiDialogStore` 继续独占 timeout；utility controller 同时最多持有一个 process-local callback record，已有业务 dialog 时拒绝新 utility open，utility 已开后到达的业务 dialog 依 reducer 栈自然置顶抢焦点，关闭后回落 utility。coordinator 必须按 focused overlayId 精确路由，未知 overlay 不误送。其三，完整交互状态（focus/checked、code-point cursor、filter/filterCursor、window、approval contentOffset、attachment、error/status）只在 controller 持有并以 revision-bumped `overlay/open` AppEvent 投影；输入编辑支持 code-point insert/delete/left/right/home/end，paste 单行化，disabled 行不可提交且导航跳过。其四，question 补齐 hideCustomInput、自定义答案 attachment、multi-select 空提交错误、plan-review 协议精确映射（approve 不得携带 feedback，feedback 走 decline）和 completed batch `takeSummaries`→`channel.pushLocal`；redact batch 的当前/完成 summary 都只含 `••••••`。其五，approval 的 command/reason 有界换行与 PgUp/PgDn 窗口、store 抛错后 fail-closed 禁止 proceed；plugin select 在 controller 过滤原始 options，payload 同时保留 `totalOptions` 以区分 empty/no-results。其六，`/help`、`/history`、`/search`、空 editor `?` 与 Ctrl+R 统一委托 utility controller。bare `/resume` 只建立 generic picker 的 `onSelect(id) -> replay.resume(id)` 边界；WP-08c 没有 session catalog，必须显示 “Session catalog arrives in WP-08d” 和明确 empty，不创建 `{kind:'session-browser'}`、不提前实现 WP-08d 的 session/model/preset browser。其七，transcript search 新增可回放 `search/update` state；当前实现诚实限定为可见 transcript 区域：controller 按可见 transcript row 产出 match rowId，renderer 只扫描本帧 `transcriptHeight` 以内（明确排除 dock）的 cell 生成 rect，宽 grapheme 整体高亮、不跨物理行，current match 使用独立 theme role；不声称离屏 physical-line index。高亮仍按 §6.3 固定绘于 overlay 之上。其八，fullscreen 渲染完整 overlay；inline 因 `supportsNestedOverlay=false` 继续剥离 business/utility overlay，每个新 overlay 明确发 dock warning + `overlay/unsupported`，键盘仍按 focused id 可操作，此行为写入支持矩阵且不得伪装 parity。其九，`interactive-overlays@v1` 是第 22 个脱敏 trace，覆盖 picker filter revision、help、history、search current/close；受控 policy 只保留 `[placeholder]` 与结构 discriminant，重新生成证明既有 21 个 fixture SHA-256 全部不变。其十，回归矩阵仅将 REG-006、REG-016、REG-025、REG-027、REG-070 转 verified；REG-026（resize/activity 布局压力）与 REG-042（完整 extension UI 注册拒绝边界）仍 open，session-browser 等 WP-08d 项不借本包关闭。其十一，不新增依赖，不修改 `src/tui-v2/vendor/**` 或 goldens。其十二，回滚方式为删除 interactive controller/payload/components/search producer，commands/input/coordinator 恢复 WP-05b 路由，search state 从 model/canonical 投影移除，trace corpus 恢复 21 并将上述五条矩阵行恢复 open；业务 store、priority 和 timeout ownership 无需回滚。

- WP-08d1 落地时锁定真实 session browser 与 workspace 选择/切换的九项决策。其一，两者都是有限模态列表，使用两个专用且互斥的 utility overlay controller，不建 `SceneV2`；组件只接收 model 层严格解析、可序列化且有界的 `session-browser-dialog` / `workspace-dialog` 投影，不导入 DSH/Cordis，异步 handle、provider callback 与业务对象只留在 controller/adapter。其二，session 过滤、lineage、root/fork/subagent kinds 与变高窗口继续复用 `src/sessions/view.ts` 的 `buildView`/`moveSelection`/`anchorTop`/`windowEnd`，cwd 范围复用 `sessionCwdMatches`，不另造路径语义。其三，资源预算固定为 session 列表 16 个 physical-line、workspace 8 items、preview 8 entries；adapter preview 只读 128 KiB tail、每条最多 400 字符并包含 `tool/call` 摘要；宽度达到 100 cells 才显示 list+preview 双栏，低于阈值时 preview 替换列表。其四，bare `/resume` 打开真实 catalog，直接 `/resume <id>` 与 catalog Enter 都只调用既有 `ReplayController.resume()`；失败留在 browser，不让 component 自行恢复 session。其五，删除固定为选中 session 的 Ctrl+D 后 plain Enter 二次确认，rename 经 adapter 回调并按 session id 保持焦点；组件和 reducer 都不直接执行文件 IO。其六，workspace bare/resume/open/rename/provider command 全由 workspace owner 解释；switch/create/attachment 只调用注入的 adapter callback，不自行修改 Channel，provider `choices`/input/AbortSignal 永不进入 AppEvent。其七，可选 provider host 缺失时使用既有 `createLocalWorkspaceRuntime()` 作为 local-only fallback，并在 payload 明示 degraded warning；能力缺失、provider 抛错或取消都保持进程可用。其八，每次 list/preview/provider 操作同时使用 `AbortController` 与 record identity + operation generation；close/dispose/new operation 后的 late result 只记有限诊断，不再发布事件。其九，fullscreen 由既有 compositor 完整渲染；inline 继续发送 `overlay/unsupported` warning 并隐藏内容，但 focused overlayId 仍归专用 owner，Esc 可关闭隐藏 overlay。`/settings`、`/model`、`/preset`、`/effort` 明确保留给 WP-08d2，不在 d1 预实现。回滚方式：删除两个专用 controller/component/payload 与 `session-workspace@v1`，恢复 bare `/resume` 的 WP-08c 占位 picker 和旧 `/workspace` transcript 降级；adapter 的可选 AbortSignal/tool preview 扩展可独立保留。

- WP-08d2 落地时锁定 settings、model、preset、effort 的十项实现决策。其一，四类能力均为 utility overlay，不建 `SceneV2`：复杂 settings 由专用 `SettingsFlowController` 持有，model/preset/effort 由共享 `ChannelOptionsController` 持有；它们与 interactive/session/workspace owners 进程内互斥，coordinator 只按 focused `overlayId` 精确路由，未知 owner 不落回 editor。其二，model 层 `settings-routing-overlay-payloads.ts` 是唯一组件边界，严格解析有界纯可序列化投影；`SettingsForm`、plugin section 的 format/parse callback、Channel、Promise/AbortSignal、credential ref/literal 全留在 controller/adapter，纯 line components 不 import dsh-adapter/Cordis，所有文本走 sanitize→grapheme/cell→wrap/truncate。其三，settings 只注入稳定 `SettingsHost`、插件 section `list/subscribe` 与 `SettingsForm` factory；text/number 用 code-point editor，boolean/select Enter 循环，字段 reset 走 `resetField`，显式 save 走 `SettingsForm.save`，reload 重读 host/sections。`SettingsForm` 保留既有 revision-fenced write + 一次 `SETTINGS_CONFLICT` fresh-revision retry + bool `save()` 契约，仅新增兼容的 `lastSaveHadConflict` 结果位供 UI 显示并发检测；secret 始终 blank-until-typed/掩码投影，绝不回读 literal。dirty Esc 固定为显式 discard-and-close confirm，reload 遇 dirty 同样先确认；plugin section/list/subscribe/format/parse/credential 异常均转受控 error/diagnostic。其四，settings save/reload/credential probe 与三个 route list/switch/set 均以 active record identity + operation generation + `AbortController`（底层无 signal 时为逻辑取消）双闸；close/dispose/new operation 先 abort/退订/增代，late completion 只计有限诊断、不再发布 AppEvent。其五，settings 双栏阈值固定为组件内容宽 `100` cells：达到阈值 section+field 同屏，低于阈值只渲染显式 active pane；width 0/1/2、CJK/emoji/combining/恶意 SGR/OSC 均经相同硬宽度保护，不能把窄屏当压扁双栏。其六，model picker 从 `Channel.listModels()` 投影 provider/name/id/description/input modalities，filter/nav/current/pending/error/working-disabled 均由 controller 管；选择只调用一次现有原子 `switchModel(rawProvider, rawModel)`，不自行 fork/reset/new/resume、不追加第二份 startup/welcome，成功后是否需要 transcript reset 仍由 Channel→adapter 既有 identity diff 决定。其七，preset picker 只投影 roster current/default/minimal/broken metadata；broken 禁用，空 roster/不存在/失败受控；选择只走 `switchPreset(rawId)`，composition、blank-session rule、持久化和 minimal tool-set 刷新继续由 presets domain/Channel 负责，UI 不复制规则。其八，effort slider 按 adapter 顺序支持 Left/Right、Tab/Shift+Tab、1--9，并串行调用现有 `setEffort(rawId)` 实时生效；pending/error 后从 `Channel.reasoningEffort` 回读 actual current，`ChannelUiAdapter` dock mirror 同时把该 actual 值投影到状态栏 `effort` segment，焦点移动本身绝不伪造状态。其九，`/settings`、bare `/model`、bare `/preset`、bare `/effort` 打开 owner；`/preset status|<id>`、`/effort status|<id>` 保留旧直接语义。fullscreen 经 compositor 完整渲染；inline 不改变支持矩阵 capability，继续剥离 overlay、逐 id 发 warning + `overlay/unsupported`，settings/model/preset/effort 虽 hidden 仍由对应 owner 吃键且 Esc 可关，明确不是 parity。其十，版本化 `settings-routing@v1` 同场覆盖 settings staged/invalid/conflict/save/reload、model current/pending/原子 route marker（无额外 startup reset）、preset current/minimal/broken/pending、effort loading/live actual；generator 使用独立最小 allowlist，既有 23 个 fixture sha256 不变。回归矩阵只将真实 UI 等价的 REG-015/018/038 转 verified；effort route config、minimal tools、atomic route、packaged presets 等纯 domain 行继续 `unaffected`。回滚方式：删除两个 controller、三类 payload/component、coordinator/commands/dock 接线与新 trace，把三条矩阵恢复 open；`SettingsForm.lastSaveHadConflict` 可独立保留或删除，旧 React UI 仍只在 WP-09 统一删除。

- WP-08e1 落地时锁定 trajectory、goal/todo、activity、context 的边界。其一，trajectory 采用内部 `SceneV2` full-screen path，复用现有 `SceneComponentAdapter`、`ScreenTakeover`、coordinator focus/restore 和统一 cells width pipeline；旧 `src/screens/TrajectoryScene.tsx` 与旧组件只保留到 WP-09 删除。其二，`src/dsh-adapter/ui-surfaces.ts` 是唯一读取 Channel/trajectory projection 的业务边界；`surface/update` 进入 model/reducer，goal/todo/activity/context 和 trajectory scene view 只发布有界、可序列化摘要，trajectory inspector 按 seq 延迟读取，绝不复制完整 raw session events、prompt 或工具 payload。其三，trajectory ledger/hotspot/wave/inspector 的 row/preview/wave/section 均有硬上限；open/filter/sort/projection/navigation/close、loading/empty/error/cancel 和 async `{sessionEpoch, adapterGeneration, controllerGeneration, focusedSeq}` fence 由 controller 持有，组件无业务副作用。其四，goal/todo 的 completed rows 在 idle 时过滤，blocked reason/rounds/overflow 进入 pure line component；activity frame、preset、stalled 判断由注入 `Clock` 的 controller/协调器负责，组件不创建 timer，resize/stop/dispose 清理 timer。其五，context bar 使用 system/prompt/assistant/thinking/tools 五段和 bounded percentage，expanded context panel 只在 transcript empty 时由 Ctrl+P 或 `/context` 打开；非空 transcript 的 `/context` 保持受控 report/notice，不重复注入 startup panel。其六，inline trajectory 明确显示 degraded notice，固定 viewport/scrollback parity 不承诺，但 scene focus 仍独占并接收全部键盘；fullscreen 是正确性参考。新增 `trajectory-goal-activity-context@v1` 脱敏 trace、surface/component/controller width matrix 和 regression rows；图片、OSC52、Kitty/iTerm2 image protocol 不在本项，图片能力由 WP-08e2 完成。回滚方式：移除 surface event/adapter/controller/components/trace 与本条记录，恢复 WP-08 前的 v2 dock/scene wiring；不修改旧 fixture bytes、vendor 或依赖。

- WP-08e2 落地时锁定图片能力边界：进程内 `ImageStore` 默认 32 MiB/128 entries、单 entry 5 MiB，上限由 LRU + generation references + explicit lease 共同约束；Frame/AppEvent/trace/诊断只传 SHA-256、metadata 与 ephemeral storeKey，原始 bytes 仅在唯一 writer encode 阶段短暂转 base64。纯 `image-placement` 组件只做 metadata 校验、viewport clip 与 placeholder；fullscreen 仅发送 profile 已确认的 Kitty APC（4096 base64 continuation、upload-before-place、受控 delete/clear）或 iTerm2 OSC 1337（cursor 定位、每 placement upload，无持久 delete parity），inline、null/unknown profile、request mismatch、sixel 和超预算统一 fallback + `unsupported-image`，不得发送图片字节。`stageImage` 维持 hash-only seam，不产生 AppEvent；Kitty placement 使用可由 wire `p=` 恢复的 canonical identity，legacy pi `screen-plan` 明确拒绝 `Frame.images`。新增 `image-store.test.ts`、`image-placement.test.ts`、`image-writer.test.ts`、`image-adapter-boundary.test.ts`、`image-fallback@v1` trace、support/regression matrix 覆盖，并保持既有 trace/vendor/golden/依赖字节不变。回滚方式：移除 `renderer/image-store.ts`、`renderer/image-placement.ts`、writer/backend image ops 与新增 image tests/trace/matrix 条目，恢复显式 unsupported fallback；不修改 vendor、golden、依赖或 lockfile。

- WP-08f 落地时锁定 external action 边界：`!`/`!!`、clipboard、external editor、update/restart、notification、theme/i18n 全部经 coordinator 注入的窄 capability；child stdout/stderr 先 sanitize、限行/限字后进入受控 local row/notification，不能穿透 writer/frame，command/env/secrets/clipboard bytes 不进 trace。external editor/update 使用 `ScreenTakeover` child lease：writer quiesce、input/raw/mouse/paste/cursor mode snapshot、child 完成或取消后恢复并 generation++/full redraw；inline 不伪装 fullscreen，不能安全 transfer 时明确 unsupported，shell transcript 只能 append-only。OSC52 copy 只调用 trusted writer builder，profile 未确认时不冒充成功；paste image 复用 `stageImage`/ImageStore。notification queue 由注入 `Clock` 驱动、bounded/dedupe/sticky/dismiss，不使 completed row cache 或 anchor 失效；theme registry/language capability 只接受 validated ids，RTL 只保证逻辑顺序和 width、不做 bidi shaping。`external-actions@v1` 只记录脱敏 summary（kind/phase/generation/count/hash），支持矩阵和 stdout ownership 文档登记 inline/fullscreen 差异；WP-08g 仍负责底层鼠标/OSC52 negotiation/host probing。回滚方式：移除 `src/tui-v2/capabilities/`、WP-08f controllers/pickers/trace/matrix 接线，恢复旧 host action seam；不修改 vendor、goldens、依赖或 lockfile。

### 15.2 编码前和最终提交前必须落档

1. pi source 的 vendored 文件清单、每个文件 hash、fork 版本号、依赖 lock 和 license/NOTICE 路径（上游 commit 已在 0.2 锁定）。
2. `TerminalProfile` 的 capability 探测超时和各终端默认值。
3. Frame 在 compositor/diff 前必须完全 cell 化（可在组件到 compositor 前保留 line-level fast path）；记录 stride、continuation、style/hyperlink pool 和 mode snapshot 的实现 hash。
4. v2 默认启用 fullscreen 的发布版本和 inline 功能差异文案。
5. `VirtualTerminal` 使用 `@xterm/headless` 的范围与本地 parser 的边界。
6. plugin row/scene 的 v2 API、breaking-release 迁移说明和旧插件终止版本。
7. 生产诊断 trace 的保存位置、权限、脱敏字段和保留周期。

### 15.3 变更规则

任何待确认项若影响 invariant、公开 plugin contract、session compatibility、终端 cleanup 或回滚能力，必须在编码前更新本文并由维护者确认；不能用“先实现再看”替代架构决策。

---

## 16. 参考资料

### 本仓库

- `src/screens/Chat.tsx`
- `src/dsh-adapter/channel.ts`
- `src/ink/`
- `src/native-ts/yoga-layout/`
- `docs/project-documentation/rendering.md`
- `docs/project-documentation/ink-core.md`
- `docs/project-documentation/ACCEPTANCE.md`
- `ADAPTER.md`

### Kimi Code

- `/home/sisct/Code/oss/kimi-code/packages/pi-tui/`
- `/home/sisct/Code/oss/kimi-code/packages/pi-tui/AGENTS.md`
- `/home/sisct/Code/oss/kimi-code/apps/kimi-code/src/tui/kimi-tui.ts`
- `/home/sisct/Code/oss/kimi-code/apps/kimi-code/src/tui/tui-state.ts`
- `/home/sisct/Code/oss/kimi-code/apps/kimi-code/src/tui/controllers/`
- `/home/sisct/Code/oss/kimi-code/apps/kimi-code/src/tui/components/`

### pi

- `/home/sisct/Code/oss/pi/packages/tui/`
- `/home/sisct/Code/oss/pi/packages/tui/src/tui.ts`
- `/home/sisct/Code/oss/pi/packages/tui/src/tui-main-screen.ts`
- `/home/sisct/Code/oss/pi/packages/tui/src/tui-alt-screen.ts`
- `/home/sisct/Code/oss/pi/packages/tui/test/`
- `/home/sisct/Code/oss/pi/tui-plan.md`

### 初始方案

- `/home/sisct/下载/新建 文本文档.txt`

初始方案中的结论、工作包依赖和验收门槛已纳入本文；本文额外补充了当前仓库路径映射、接口契约、任务编号、CI guard、外部回滚和插件/Channel 迁移边界。
