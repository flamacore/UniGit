# Theme Customization

UniGit supports theming in two layers:

1. End-user custom themes through the Appearance section in the app.
2. Full built-in themes in code by adding a new preset to the stylesheet and theme settings.

The current implementation is centered around CSS variables applied to `document.documentElement`.

## Quick Start For Users

Open Repo Manager, then go to the `Appearance` section.

If you want a simple custom theme:

1. Select `Custom`.
2. Pick a base preset such as `Dark`, `Light`, or `Liquid Glass`.
3. Paste a JSON object with CSS variable overrides.

Example:

```json
{
  "--accent": "#8cb6ff",
  "--accent-2": "#72f0df",
  "--surface-card": "rgba(255, 255, 255, 0.08)",
  "--surface-button": "rgba(255, 255, 255, 0.12)",
  "--line-strong": "rgba(140, 182, 255, 0.42)"
}
```

A larger paste-ready example is available at [docs/examples/aurora-glass-theme.json](examples/aurora-glass-theme.json).

Important:

- Custom themes in the current UI override CSS variables only.
- The JSON must be a flat object.
- Keys must start with `--`.
- Values must be strings or numbers.

## How The Theme System Works

### Runtime application

The app applies theme presets in [src/app/App.tsx](src/app/App.tsx) by:

- Setting `document.documentElement.dataset.theme`
- Setting `document.documentElement.style.colorScheme`
- Applying any custom variable overrides directly on the root element

### Theme settings and validation

Theme preset IDs, saved state, JSON parsing, and validation live in [src/app/utils/themeSettings.ts](src/app/utils/themeSettings.ts).

### CSS source of truth

All theme variables and theme-specific selector overrides live in [src/styles.css](src/styles.css).

The main pattern is:

```css
:root[data-theme="my-theme"] {
  --accent: #8cb6ff;
  --surface-card: rgba(255, 255, 255, 0.08);
}

:root[data-theme="my-theme"] .panel,
:root[data-theme="my-theme"] .change-card {
  backdrop-filter: blur(28px) saturate(165%);
}
```

## Variables You Will Usually Override

These variables give the biggest visual change with the least work:

- `--app-background`
- `--panel-bg-start`
- `--panel-bg-end`
- `--surface-section`
- `--surface-row`
- `--surface-card`
- `--surface-input`
- `--surface-button`
- `--surface-button-strong`
- `--surface-button-active`
- `--surface-selection`
- `--surface-selection-soft`
- `--line`
- `--line-strong`
- `--text-1`
- `--text-2`
- `--text-3`
- `--accent`
- `--accent-2`
- `--control-accent`

For glass-like themes, these extra variables matter as well:

- `--panel-backdrop-filter`
- `--surface-backdrop-filter`
- `--control-backdrop-filter`
- `--glass-surface-highlight`
- `--glass-control-highlight`
- `--glass-surface-shadow`
- `--glass-control-shadow`
- `--glass-rim`

## Common Selectors For Theme-Specific Styling

If variables alone are not enough, these selectors are the main places to add extra treatment:

- `.panel`
- `.repo-tab`
- `.repo-manager-section`
- `.repo-manager-row`
- `.lane`
- `.change-card`
- `.selection-card`
- `.commit-box`
- `.preview-frame`
- `.branch-panel`
- `.branch-row`
- `.graph-viewport`
- `.icon-button`
- `.ghost-button`
- `.branch-chip`
- `.sync-chip`
- `.changes-filter`
- `.changes-select`
- `.commit-box__input`
- `.history-filter`

The existing liquid-glass theme in [src/styles.css](src/styles.css) is a good example of using both variables and targeted selectors.

## Adding A New Built-In Theme

If you want a first-class theme preset instead of JSON overrides:

1. Add the new preset ID to [src/app/utils/themeSettings.ts](src/app/utils/themeSettings.ts).
2. Add its label and description to `themeOptions`.
3. Add a `:root[data-theme="your-theme"]` block in [src/styles.css](src/styles.css).
4. Add any theme-specific selector rules below the shared button and panel styles.
5. Make sure the runtime `colorScheme` in [src/app/App.tsx](src/app/App.tsx) matches the visual intent of the theme.

Use `dark` unless the theme is genuinely light, because native scrollbars and form controls follow that setting.

## Example CSS Preset

An example preset file is available at [docs/examples/aurora-glass-theme.css](docs/examples/aurora-glass-theme.css).

## Example JSON Theme

An example JSON override file is available at [docs/examples/aurora-glass-theme.json](docs/examples/aurora-glass-theme.json).

That file is designed to be pasted into the app's `Custom` theme textarea.

It shows:

- A complete variable-only version of the Aurora Glass look
- Real gradient, shadow, blur, and surface values in JSON form
- A format that matches the validation rules in the app

That file shows:

- A complete `:root[data-theme="aurora-glass"]` variable block
- Shared glass variables
- Theme-specific selector overrides for panels, cards, controls, and the graph viewport

Note:

- The example CSS file is for contributors adding a built-in theme or for future import tooling.
- The example JSON file is for end users customizing the app today.
- The example CSS file can do more than JSON because selector-specific rules like `.panel` or `.graph-viewport` cannot be represented in the current custom theme editor.
