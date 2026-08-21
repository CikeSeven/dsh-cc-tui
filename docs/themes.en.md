# Themes

[Documentation index](README.md) · [简体中文](themes.md)

## Production theme

The production v2 registry registers only `default`. Embedders may supply extra
descriptors through `createTuiV2App({ themeDescriptors })`; an unregistered id
(including one persisted by an older release) safely falls back to `default` and
never loads a retired renderer or second theme implementation.

Selection precedence is:

```text
explicit createTuiV2App theme
  > DSH_TUI_THEME
  > persisted registry id in ~/.dsh-tui/theme.json
  > default fallback
```

## Switching themes

- `/theme` opens the v2 registry picker; it lists `default`, then injected descriptors.
- `/theme <name>` switches directly.
- `/theme status` shows the current theme and persistence location.

Confirming a choice hot-switches immediately and writes it to
`~/.dsh-tui/theme.json`. `DSH_TUI_THEME`, when set, still wins on the next launch.

## v2 theme descriptors

Production v2 does not dynamically load a second theme implementation from a user
folder. Hosts/plugins register descriptors through
`createTuiV2App({ themeDescriptors })`; the registry accepts only a safe id, a
single-line display name, `default|dark|light|ansi` base, and known-role
`LineStyle` values:

```ts
{
  id: 'night-owl',
  displayName: 'Night Owl',
  base: 'dark',
  roles: { accent: { foreground: '#ff00aa', bold: true, ... } }
}
```

`src/utils/themeName.ts` rejects traversal/control input and
`src/tui-v2/theme/registry.ts` rejects unknown roles/invalid colors, falling back
to `default` for an unknown id. When truecolor is not confirmed by host
capabilities, `resolveThemeForProfile` quantizes roles to ANSI-256; it never
silently starts another renderer. Persistence stores only a safe registry id in
`~/.dsh-tui/theme.json`.

Descriptor registration, invalid input, truecolor degradation, and preference
round-trips are covered by `node --import tsx/esm scripts/verify-themes.mjs` and
`test/tui-v2/theme-i18n-width.test.ts`.

## Color formats

Accepted forms:

- `#rgb`
- `#rrggbb`
- `#rrggbbaa`
- `rgb(r,g,b)`
- `ansi256(n)`
- 16-color names such as `ansi:black` and `ansi:redBright`

Colors must be concrete values. CSS variables, gradients, and arbitrary CSS
color names are not accepted.

## Validation and failure behavior

- Unknown Theme key: skip that key with a warning and keep the rest.
- Invalid color: skip that value with a warning.
- Invalid `base`, malformed JSON, or non-object `colors`: skip the whole file.
- Missing theme referenced by the environment or preference file: warn and
  continue with background detection.
- One bad theme never blocks TUI startup or other themes.

Theme names are user input. The loader verifies that the resolved path remains
inside `~/.dsh-tui/themes/`, preventing names from escaping the theme directory.
Preserve that containment check when changing the implementation.

## Design guidance

- Use semantic keys instead of changing only `text` and `background`. Check at
  least body, inactive, focus, selection, success, warning, error, and diff
  colors.
- Test light themes in a real light terminal and dark themes in a dark one.
- Check 16-color, 256-color, and truecolor fallback behavior.
- Verify narrow layouts, tool diffs, questionnaires, multiline input, and
  selection contrast.
- Theme files should contain display metadata and color only, never credentials
  or other user data.

When developing the theme subsystem, run:

```sh
node --import tsx/esm scripts/verify-themes.mjs
```

See [Architecture and limitations](architecture.en.md) for terminal capability
and renderer details.
