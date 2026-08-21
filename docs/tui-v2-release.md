# tui-v2 verified release / rollback contract（WP-09c2）

本项目的 release 只允许在 CI 中执行最终 `npm publish`。本地可以执行
`compile`、`npm pack`、package/tarball verifier 和 rollback child drill，但不执行
真实 `npm publish`、registry mutation 或未知 launcher。

## 固定 artifact 流

publish workflow 必须在同一个编译输出上严格执行以下顺序：

```sh
pnpm compile
outDir="${RUNNER_TEMP:-$(node -p "require('os').tmpdir()")}/tui-v2"
mkdir -p "$outDir"
packJson="$outDir/pack.json"
rollbackManifest="$outDir/rollback-manifest.json"
npm pack --ignore-scripts --json --pack-destination "$outDir" --foreground-scripts=false > "$packJson"
tgz=$(cd "$outDir" && node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1])); const x=Array.isArray(r)?r[0]:Object.values(r)[0]; process.stdout.write(require('path').resolve(x.filename))" "$packJson")
sha=$(sha256sum "$tgz" | cut -d' ' -f1)
node scripts/verify-package.mjs < "$packJson"
node scripts/verify-tui-v2-tarball.mjs \
  --tarball "$tgz" --sha256 "$sha" --pack-json "$packJson" \
  --rollback-manifest "$rollbackManifest"
# CI only, after the verified artifact and all final gates:
npm publish "$tgz" --ignore-scripts --access public --provenance
```

根包不定义 `prepare`；构建只由显式的单次 `pnpm compile` 负责。npm 10 在
`npm pack --ignore-scripts` 下仍可能触发生命周期并把 workspace 日志写入 JSON，故 pack
同时固定 `--foreground-scripts=false`，并由无 `prepare` 契约从根源阻止二次 compile。
`verified-tarball.json` 是唯一 publish 输入的可信记录：
publish step 必须重新读取其中的 absolute `artifact.tarball` 和 `artifact.sha256`，
再计算 hash 并确认路径相同。rollback 输入则必须来自显式
`TUI_V2_ROLLBACK_ARTIFACT_RUN_ID` 的上一 verified-release artifact；下载后还要
核对 previous version、basename 和 SHA，不能只相信 registry/name。publish response
和 response/tarball hash 会写入并上传 `publish-record.json`。普通 `npm publish`、
第二次 `npm pack`、验证后的 build/prepare 都是阻断条件。

## verified-tarball.json

`verify-tui-v2-tarball.mjs` 不联网、不运行 launcher，且要求四个参数：

- `--tarball`：已经生成的 regular `.tgz`；
- `--sha256`：该文件的 lowercase exact SHA-256；
- `--pack-json`：同一次 `npm pack --json` 的唯一报告；
- `--rollback-manifest`：同一 release 的 rollback manifest。

输出默认为 `$RUNNER_TEMP/tui-v2/verified-tarball.json`，没有 `RUNNER_TEMP` 时使用
`os.tmpdir()/tui-v2/`。输出以临时文件 + rename 原子写入，包含 schema/status、
absolute tarball/hash、pack JSON path/hash、排序后的包文件 manifest/hash、exports
和依赖检查、vendored pi-tui 的 `LICENSE`/`NOTICE`/`PATCH-LEDGER.md`/
`VENDOR-MANIFEST.json` 证据、rollback 摘要，以及 Node/npm/pnpm/git/lockfile identity。
不会写 signature ref、token、环境全量、prompt 或 raw terminal bytes。

verifier 先列出 tar，再拒绝绝对路径、`.`/`..`、反斜杠、重复 entry、非
`package/` 根和 symlink/hardlink/device/FIFO，之后才安全提取并二次 `lstat`。
包面不得含 `src/`、离线 baseline tools、旧 React/reconciler/Yoga 路径或依赖；
`main`、`types`、`bin`、`exports` 的每一个 target 都必须存在。

## rollback manifest

manifest 是 release runner 生成的不可变 JSON，不由 verifier 猜测：

```json
{
  "schemaVersion": 1,
  "registry": "https://registry.example.invalid/",
  "package": "@scope/dsh-tui",
  "version": "1.2.3",
  "tarball": "scope-dsh-tui-1.2.3.tgz",
  "sha256": "lowercase-64-hex",
  "signature": { "algorithm": "sigstore|gpg", "ref": "immutable-signature-ref" },
  "sessionSchema": { "min": 1, "max": 1 },
  "launcher": { "command": "dsh-tui-rollback", "args": ["--package", "..."], "timeoutMs": 30000, "retries": 2 },
  "retention": { "keepStableVersions": 1, "expiresAt": "2030-01-01T00:00:00Z" }
}
```

`create-tui-v2-rollback-manifest.mjs` 要求所有 release 值由 CLI 或
`TUI_V2_ROLLBACK_*` 环境提供，绝不生成 production signature/ref 或 previous
version。`--tarball` 如提供会做 exact local hash 校验；生成器输出固定 JSON 并
再次 schema 校验。`verify-package.mjs --rollback` 是独立模式；无参数的
`pnpm verify:package` 仍然只读 stdin 的 npm pack JSON。

registry、signature/ref、previous-version、session compatibility、launcher
command/args/timeout/retries、retention 和 exact previous tarball 缺任一项时，CI
fail closed。当前工作树没有伪造的 production previous release；测试使用临时
当前 tgz 和显式 `fixture-test-signature-ref`，报告标记为 `fixture` 或
`unsupported-by-host`。

## rollback 语义与 child drill

renderer 崩溃路径只允许当前进程 cleanup 后以专用非零码结束：不在进程内切换
renderer、不双写 stdout、不把离线 baseline 当 fallback。`verify:rollback` 会 spawn
失败 child，覆盖 failed-before/after-takeover、stdin close、cleanup deadline、
重复 signal，并检查 raw/alternate/mouse/paste/cursor 恢复、cleanup 次数、stdout
ownership 和 `fallbackSwitchCount === 0`。随后用 dry-run/no-network launcher 校验
manifest command/args 的原样传递；不会连接 registry 或运行生产 launcher。

真实 release 的上一包和不可变 signature/ref 由 release 环境提供。若宿主没有真实
previous artifact，只能通过明确的 fixture/`unsupported-by-host` 证据；不能把缺失
artifact 报成 rollback 成功。
