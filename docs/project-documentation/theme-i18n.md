# 主题系统与 i18n

本文覆盖 v2 theme registry、持久化偏好、profile capability downgrade，以及
en/zh 双语 i18n 系统与 `/lang` 热换。旧 theme implementation 的名称只在 frozen
provenance 中保留，不再是生产 import 或配置入口。

## v2 主题 registry

`src/tui-v2/theme/registry.ts` 是纯 registry state：descriptor 以安全 id 注册，
`ComponentTheme` role 由 `src/tui-v2/components/theme.ts` 消费；registry 不直接读
环境或文件。`src/themePrefs.ts` 只负责 `~/.dsh-tui/theme.json` 的 best-effort
读取/写入，并通过 `src/utils/themeName.ts` 拒绝路径穿越、控制字符和不安全 id。

`createTuiV2App` 的解析顺序是显式 `theme` → `DSH_TUI_THEME` → persisted preference
→ registry fallback。`resolveThemeForProfile` 在 unknown/no truecolor host 上把
truecolor role 确定性量化为 ANSI-256，并记录 degradation diagnostic；没有静默
切换第二 renderer。

- 未知主题名回退 `dark`（src/theme.ts:346-355）。
## v2 启动解析链

```text
createTuiV2App(options.theme)
  -> DSH_TUI_THEME
  -> readThemePref() from ~/.dsh-tui/theme.json
  -> createThemeRegistry(themeDescriptors)
  -> resolveThemeForProfile(profile)
  -> coordinator preference controller + frame renderer
```

主题 registry 是纯内存 contract；文件和环境只由 bootstrap/capability seam 读取。
unsafe/corrupt preference 会回到 registry fallback；unknown/no truecolor host 会
确定性量化 truecolor role，不写出未经能力确认的序列。

## /theme 与 /lang 命令

| 命令 | 形态 | 行为 | 位置 |
| --- | --- | --- | --- |
| /theme | `/theme status` | 显示当前 v2 registry selection | `src/tui-v2/controllers/preferences.ts` |
| /theme | `/theme <name>` | registry resolve + best-effort persistence | `src/tui-v2/controllers/preferences.ts` |
| /theme | 裸 /theme | 打开 v2 picker overlay | `src/tui-v2/controllers/commands.ts` |
| /lang | `/lang status` | 显示当前语言 | `src/tui-v2/controllers/preferences.ts` |
| /lang | `/lang en\|zh` | persistence seam → setLang 热切 | `src/tui-v2/controllers/preferences.ts` |

/theme 切换先通过 registry 校验，再写 `~/.dsh-tui/theme.json`；写入失败会保留
当前进程选择并发 diagnostic，不静默丢失用户选择。

## 用户自定义主题（0.2.0，提交 33a4a07）

文件：`~/.dsh-cc/themes/<name>.json`，结构 { name?, displayName?, base,
colors }：

- base 必需（light/dark/dark-ansi），buildTheme 以 base 调色板为底叠加
  colors 覆盖（src/customTheme.ts:249-256）。
>> 历史 baseline 说明：以下旧自定义主题文件格式、旧路径和旧 picker 只作为
> WP-09a frozen provenance；它们不再由生产 v2 runtime import 或执行。当前生产
> descriptor 使用 `src/tui-v2/theme/registry.ts`，验证入口是
> `node --import tsx/esm scripts/verify-themes.mjs`。

## i18n 系统（#22，提交 283aba1）

- 扁平 dict：**215 个键**（程序化计数），每键 {zh, en} 字符串对，zh 默认
  （src/i18n.ts:30-279）；t(key, params) 做 {{name}} 占位替换，缺键渲染键名
  本身——"a typo is visible in the UI instead of silently blank"
  （src/i18n.ts:13-17,322-328）。
- 语言解析链保持 `DSH_TUI_LANG` → config/language option → persisted
  `~/.dsh-tui/lang.json` → OS locale → `zh` fallback；`parseLangPref` 只接受
  `zh/en`。
- bootstrap 在首帧前固定语言；preferences controller 通过 listener 触发 v2
  scheduler 重绘，非 UI domain module 直接调用 `t()`。
- v2 偏好回归由 `scripts/verify-themes.mjs` 与 `test/tui-v2/theme-i18n-width.test.ts`
  覆盖；旧 customTheme/ThemeProvider/React 讨论仅是冻结 provenance，不再是当前
  implementation 的未验证项。

## 未验证事项

- `/lang` 是否影响其他已挂载 DSH 插件的 UI 文案仍取决于宿主插件自身的 i18n
  contract；本包只保证自身 catalog 与 v2 preferences。
- 7b425de（消息列表虚拟化）被 git log --grep 'theme' 命中仅因提交体含回归
  统计字样 "theme 22/22"，与主题功能无关；主题提交清单应以标题明确的
  6dc0f4b/843fb76/33a4a07/283aba1 为准。

相关文档：[ink-core.md](ink-core.md)（终端能力探测/querier）、
[lifecycle.md](lifecycle.md)（启动序）、[input-commands.md](input-commands.md)
（/theme、/lang 命令入口）、[unknowns.md](unknowns.md)。
