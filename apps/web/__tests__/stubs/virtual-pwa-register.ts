// Test stub for vite-plugin-pwa's `virtual:pwa-register` module, which only
// exists during a real vite build. `vitest.config.ts` aliases the virtual id
// here so the resolver succeeds; tests still `vi.mock` it to assert calls.

export const registerSW = (): ((reloadPage?: boolean) => Promise<void>) => {
  return async () => undefined;
};
