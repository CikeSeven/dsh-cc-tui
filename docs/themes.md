# 主题系统

[文档索引](README.md) · [English](themes.en.md)

## 生产主题

生产 v2 registry 默认只注册 `default`。Embedder 可以通过
`createTuiV2App({ themeDescriptors })` 注入额外 descriptor；未注册 id（包括旧版本
偏好文件里的名字）安全回退 `default`，不会加载旧 renderer 或第二套主题实现。

选择优先级：

```text
显式 createTuiV2App theme
  > DSH_TUI_THEME
  > ~/.dsh-tui/theme.json 中的持久化 registry id
  > default fallback
```

## 切换主题

- `/theme`：打开 v2 theme registry 选择器；默认列出 `default`，其后为注入的 descriptors。
- `/theme <name>`：直接切换。
- `/theme status`：显示当前主题与持久化位置。

选择器确认后立即热切换，并把选择写入 `~/.dsh-tui/theme.json`。如果设置了
`DSH_TUI_THEME`，它在下一次启动时仍然优先。

## v2 theme descriptors

生产 v2 不从用户主题目录动态加载第二套 theme implementation。Host/plugin 通过
`createTuiV2App({ themeDescriptors })` 注册 descriptor；registry 只接受安全 id、
单行 displayName、`default|dark|light|ansi` base 与已知 role 的 `LineStyle`：

```ts
{
  id: 'night-owl',
  displayName: 'Night Owl',
  base: 'dark',
  roles: { accent: { foreground: '#ff00aa', bold: true, ... } }
}
```

`src/utils/themeName.ts` 拒绝路径穿越与控制字符，`src/tui-v2/theme/registry.ts`
拒绝未知 role/非法颜色并在未知 id 时回退 default。truecolor 不被 host capability
确认时，`resolveThemeForProfile` 将 role 量化为 ANSI-256；不会静默启动另一个
renderer。主题持久化只写安全 registry id 到 `~/.dsh-tui/theme.json`。

自定义 descriptor 的注册、非法输入、truecolor 降级和 preference round-trip 由
`node --import tsx/esm scripts/verify-themes.mjs` 与
`test/tui-v2/theme-i18n-width.test.ts` 覆盖。

## 颜色格式

支持：

- `#rgb`
- `#rrggbb`
- `#rrggbbaa`
- `rgb(r,g,b)`
- `ansi256(n)`
- `ansi:black`、`ansi:redBright` 等 16 色 ANSI 名称

颜色必须是具体值，不能使用 CSS 变量、渐变或任意 CSS 颜色名。

## 校验与失败策略

- 未知 Theme 键：跳过该键并写入警告，其余颜色继续生效。
- 非法颜色：跳过该值并写入警告。
- 非法 `base`、损坏的 JSON、非对象 `colors`：跳过整个文件。
- 环境变量或偏好文件引用不存在的主题：写入警告并继续背景自动检测。
- 一个坏主题不会阻止 TUI 启动，也不会影响其他主题。

主题名来自用户输入，加载器会检查路径是否仍位于主题目录内，防止通过名称跳出
`~/.dsh-tui/themes/`。修改这部分实现时必须保留路径约束。

## 设计建议

- 使用语义键而不是只替换 `text` 与 `background`。至少检查正文、非活动文字、
  焦点、选择、成功、警告、错误和 diff 色。
- 浅色主题应在真正的浅色终端验证；深色主题同理。
- 检查 16 色、256 色和 truecolor 终端的回退表现。
- 在窄终端、工具 diff、问卷、多行输入与选区状态下检查对比度。
- 不要把密钥或其他用户数据写进主题文件；主题只应包含显示元数据和颜色。

开发主题系统时运行：

```sh
node --import tsx/esm scripts/verify-themes.mjs
```

进一步的终端能力与渲染说明见[架构与限制](architecture.md)。
