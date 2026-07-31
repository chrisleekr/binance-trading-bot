// Lazy per-strategy preview loader. Each registered strategy exposes a
// `./preview` subpath (packages/strategy/*/package.json) exporting its pure
// previewLevels + previewDataNeeds; the web dynamic-imports that module so the
// strategy's decimal.js math stays in a code-split chunk, never the main bundle
// (apps/web is decimal-barred). This is the ONLY web surface that names the
// strategy plugins for previews — adding a strategy = one entry here plus its
// registry + `./preview` export (both CI-gated by no-missing-preview-export.sh).

import type { PreviewInput, PreviewModel } from '@app/strategy-core';

/** Normalised shape of a strategy's `./preview` module the web consumes. */
export interface PreviewModule {
  readonly previewLevels: (input: PreviewInput<unknown, unknown>) => PreviewModel;
  readonly previewDataNeeds: (
    config: unknown,
  ) => readonly { readonly interval: string; readonly frames: number }[];
}

// Keyed by strategy `name` (the value the symbol-state / profile row carries).
// The import specifiers below are what no-missing-preview-export.sh greps for,
// so keep them as literal `@app/strategy-*/preview` strings.
const LOADERS: Readonly<Record<string, () => Promise<PreviewModule>>> = {
  'trailing-trade': () =>
    import('@app/strategy-trailing-trade/preview').then((m) => ({
      previewLevels: m.ttPreviewLevels as PreviewModule['previewLevels'],
      previewDataNeeds: m.ttPreviewDataNeeds as PreviewModule['previewDataNeeds'],
    })),
  momentum: () =>
    import('@app/strategy-momentum/preview').then((m) => ({
      previewLevels: m.momentumPreviewLevels as PreviewModule['previewLevels'],
      previewDataNeeds: m.momentumPreviewDataNeeds as PreviewModule['previewDataNeeds'],
    })),
  rebalance: () =>
    import('@app/strategy-rebalance/preview').then((m) => ({
      previewLevels: m.rebalancePreviewLevels as PreviewModule['previewLevels'],
      previewDataNeeds: m.rebalancePreviewDataNeeds as PreviewModule['previewDataNeeds'],
    })),
};

/** True when a strategy ships a lazy preview module. Own-property only, so a
 * prototype key ('constructor', 'toString') never resolves to an Object member. */
export const hasPreviewModule = (strategyName: string): boolean =>
  Object.hasOwn(LOADERS, strategyName);

/** Load a strategy's preview module, or reject when the strategy has none. */
export const loadPreviewModule = (strategyName: string): Promise<PreviewModule> => {
  const loader = Object.hasOwn(LOADERS, strategyName) ? LOADERS[strategyName] : undefined;
  if (loader === undefined) {
    return Promise.reject(new Error(`no preview module for strategy ${strategyName}`));
  }
  return loader();
};
