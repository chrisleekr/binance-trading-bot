# `@app/web`

Frontend SPA: Vite 7 + React 19 + TanStack Router/Query + Tailwind v4 + shadcn/ui.

## Scripts

- `bun run --filter @app/web dev`: Vite dev server on `http://127.0.0.1:5173`.
- `bun run --filter @app/web build`: `tsc -b` then `vite build`.
- `bun run --filter @app/web preview`: preview production build.
- `bun run --filter @app/web lint|typecheck|test`: quality gates.

## Architecture

- **Routing**: TanStack Router 1.x, programmatic (`apps/web/src/router.ts`). The routes live under `apps/web/src/routes/` and are stitched together explicitly, not via the file-based codegen plugin. Keeps `tsc -b` self-sufficient with no pre-build codegen.
- **Data**: TanStack Query 5.x. `QueryClient` is constructed in `main.tsx`.
- **Layout**: `<AppShell>` is the responsive primitive (bottom nav <md, header top-nav ≥md). It hosts the `<DemoBanner>` and a profile-switcher slot (`data-testid="profile-switcher-slot"`) wired in 07.05. On desktop the header's middle slot hosts the live trading ticker (`TopBarTicker`, `data-testid="topbar-ticker"`), a marquee of open-position and open-order counts, unrealised and realised-today P/L per quote, and a chip per held coin (amount + percent), over live+enabled profiles only. On mobile the same marquee rides a full-width sub-bar under the header (`TopBarTickerBar`, `data-testid="topbar-ticker-mobile"`), not an icon. The header status cluster (`TopBarStatus`) no longer carries a P/L snapshot.
- **Theme**: light + dark via `[data-theme]` on `<html>`. Tokens live in `src/styles/app.css`. Cross-tab sync via `BroadcastChannel('theme')` with a `storage` event fallback for Safari ≤ 14 (`useTheme` hook).
- **i18n shim**: `t(key, vars?)` in `src/lib/i18n.ts`. Ships English-only with a typed signature so a future swap to formatjs/lingui is one line.

## i18n provider swap

```ts
import { setI18nProvider } from '@/lib/i18n';
import { i18n } from '@lingui/core'; // example

setI18nProvider((key, vars) => i18n._(key, vars));
```

Call `setI18nProvider` once at boot before `ReactDOM.createRoot(...).render(...)`. The `t()` function continues to work for every existing call site.

## shadcn components

Selectively installed under `src/components/ui/`. To add more:

```sh
bunx shadcn@latest add <component>
```

The `cn()` utility lives in `src/lib/cn.ts`.
