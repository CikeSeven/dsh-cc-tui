# tui-v2 PTY runner / build contract（WP-09c1）

`pnpm soak:tui-v2` 有两条明确且不可互换的终端证据路径：

- PR 默认路径是仓库内 fake duplex stream + `VirtualTerminal`，artifact 的
  `terminal.type` 为 `fake-duplex`、`realPty: false`。
- nightly、release 和手工 host gate 必须带 `--require-pty`，artifact 的
  `terminal.type` 为 `real-pty`、`realPty: true`。它使用 node-pty 创建 Unix
  PTY 或 Windows ConPTY，再以 `process.execPath --expose-gc --import tsx/esm`
  启动同一个 v2 soak child。

fake 证据不能满足真实宿主 gate；真实 PTY 的短 smoke 也不能冒充 8/24 小时
soak 或 100k/full-window gate。

## 固定依赖与 native build

| 项目 | 固定值 |
| --- | --- |
| manifest | `devDependencies.node-pty = "1.1.0"`（exact） |
| lockfile | `node-pty@1.1.0`, integrity `sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==` |
| N-API helper | `node-addon-api@7.1.1`（由 lockfile 固定） |
| pnpm policy | `pnpm-workspace.yaml` 的 `allowBuilds.node-pty: true`；native install script 不得被静默忽略 |
| loader | `node --expose-gc --import tsx/esm` |

`node-pty` 仅在 `--require-pty` 时动态加载；fake PR soak 不加载 native
binding。因此依赖下载成功但当前宿主无法编译 native binding 时，fake 路径仍可运行，
但任何 `--require-pty` job 必须 fail closed。

本地 Linux 验证使用 node-gyp、Python 3、GNU make 和 C++ compiler 从
`src/unix/pty.cc` 构建 `build/Release/pty.node`。runner 合同如下：

- `ubuntu-latest`：Node 22.19 或 24、Python 3、`build-essential`/GNU make、
  C/C++ compiler；必须能打开 Unix PTY。
- `macos-latest`：Node 22.19 或 24、Xcode Command Line Tools、Python 3；
  必须能打开 Darwin PTY。
- `windows-latest`：Node 22.19 或 24、Python 3、Visual Studio Build Tools
 （Desktop development with C++）和 Windows SDK；必须能创建 ConPTY。

runner image 名、Node、OS/kernel、CPU/RAM、npm/pnpm、lock hash、HEAD/dirty
状态都写入每个 soak artifact。容器 job 还必须通过
`TUI_V2_CONTAINER_IMAGE` / `TUI_V2_CONTAINER_DIGEST` 传入不可变 image
identity；普通 host runner 使用明确的 `not-applicable-host`，不能省略字段。

仓库不支持 `DSH_CC_NODE_PTY`、任意 binary path 或个人机器 override；只有
lockfile 中 exact `node-pty@1.1.0` 是真实路径的 provider。

## 能力与失败合同

`--require-pty` 的 parent 只保留 PTY transport 的 byte count、chunk count 和
SHA-256，不保存 raw terminal bytes。child artifact 同样只保留 terminal output
count/hash、frame/grid hash（fake 才有 grid）、latency、queue 和资源统计；不保存
prompt、输入原文、OSC payload、环境或 credential。

下列任一情况都必须原子写出 `schemaVersion: 1` artifact，设置
`status: "fail"`、`reason: "pty-unavailable"`（或更具体的 non-zero child
failure），并以非零退出：

- 无法动态加载 `node-pty` 或 native binding；
- `spawn()` 不存在或 Unix PTY 创建失败；
- Windows runner 无法创建 ConPTY；
- child 不是 stdin/stdout 双 TTY；
- child 没有 `global.gc`、异常退出或没有产生可解析 artifact。

禁止把这些情况标为 `skipped` 或退回 fake stream。测试中的确定性 unavailable
注入仅在 `NODE_ENV=test` 且 `TUI_V2_TEST_PTY_UNAVAILABLE=1` 时生效，变量本身
不会写入 artifact，也不是 runner capability override。

## 长时 host job

GitHub-hosted runner 的单 job 时间上限短于 24 小时，因此 host workflow 使用
连续 artifact chain：nightly 为 `2 × 240 min = 8h`，release 为
`5 × 288 min = 24h`。每段都独立执行 `--require-pty`，上传 real-PTY artifact；
下一段必须验证 run/profile/seed/host identity 和前段 SHA-256，再开始新的进程。
aggregate gate 只在所有段齐全且总时长精确满足合同后通过，并明确报告这是
多进程连续证据链，不声称单进程 24 小时。
