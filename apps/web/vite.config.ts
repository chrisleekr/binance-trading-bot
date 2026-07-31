import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// Vendor chunk strategy. Splitting react / tanstack into their own chunks gives
// each route a smaller initial payload AND lets the browser cache the vendor
// bundles across deploys that only touch app code.
//
// Recharts is deliberately NOT named here. Vite emits a `<link
// rel="modulepreload">` in index.html for every manualChunk vendor split that
// the entry's static route graph can reach — even when the only importer sits
// behind a dynamic import(). So forcing recharts into a vendor chunk made it
// load on first paint regardless of `React.lazy`. Leaving it unnamed lets it
// ride the auto-generated async chunk of its lazy importer (the dashboard's
// equity-pnl-card), which Vite does NOT preload — so recharts (~0.5 MB raw)
// is fetched only when that card renders. lightweight-charts stays a
// named chunk: it is reached only through nested dynamic imports (lazy symbol
// workspace -> candle chart), so its vendor-charts split is never statically
// reachable and never preloaded, while keeping it cacheable on its own.
const vendorChunkFor = (id: string): string | undefined => {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('react-dom') || id.match(/[\\/]react[\\/]/)) return 'vendor-react';
  if (id.includes('@tanstack')) return 'vendor-tanstack';
  if (id.includes('lightweight-charts')) return 'vendor-charts';
  if (id.includes('@radix-ui')) return 'vendor-radix';
  if (id.includes('decimal.js')) return 'vendor-decimal';
  return undefined;
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA service worker via Workbox. `prompt` (not `autoUpdate`): a refresh
    // mid-trade is forbidden, so the new worker waits and `src/lib/pwa.ts`
    // surfaces a toast for the operator to apply it. `injectRegister: false`
    // keeps registration out of the HTML so the `VITE_PWA` kill switch in
    // `pwa.ts` is the only path that registers a worker. `manifest: false`
    // leaves `public/manifest.json` as the manifest source of truth.
    //
    // Trading-correctness rule: `/api` must never be served from cache. It is
    // not matched by `globPatterns` (precache) and there is no `runtimeCaching`
    // rule, so every `/api` request reaches the network — never add a
    // `runtimeCaching` entry matching `/api`. `navigateFallbackDenylist` keeps
    // the SPA shell off `/api` navigations. The hand-rolled worker's
    // `?sw=bypass` escape hatch is intentionally dropped: with no runtime cache
    // there is nothing to bypass, and Settings → Unregister stays the operator
    // teardown path.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Listen on all interfaces (0.0.0.0) so the dev UI is reachable from other
    // devices on the LAN (e.g. a phone at http://<host-ip>:5173). The `/api`
    // proxy targets localhost:3000 on the native `bun run dev` path where the
    // proxy and the api share a host. In the dockerized dev stack the web and
    // api run in separate containers, so the override points at the api service
    // (`API_PROXY_TARGET=http://api:3000`). See the WEB_ORIGIN note if auth 403s
    // from a non-localhost origin.
    host: true,
    port: 5173,
    // Forward SPA-issued `/api/*` calls to the bun API on :3000. Without
    // this the SPA's relative `/api` requests land on vite, which serves
    // the index.html fallback for unknown paths; apiFetch then JSON-parses
    // HTML and surfaces a "Not Found" error boundary across every route.
    //
    // ws:true is required for the per-profile event stream
    // (/api/profiles/:id/ws). The shorthand string form proxies HTTP only;
    // without ws:true vite never forwards the upgrade and the socket is
    // caught by vite's own HMR server instead. Origin is left intact
    // (rewriteWsOrigin unset) so the API's Origin === WEB_ORIGIN check holds.
    proxy: {
      '/api': {
        target: process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
        // A slow upstream response (http-proxy's shorter default drops the
        // socket mid-call, so the browser 500s while the API still returns 200)
        // gets generous headroom on both the upstream response (proxyTimeout)
        // and the incoming socket (timeout). The backtest advisor runs in the
        // background and is polled, so its calls return fast regardless.
        // Dev-only; production fronts the API with its own edge.
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: vendorChunkFor,
      },
    },
  },
});
