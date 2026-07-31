import { buildNotifyRegistry, type NotifyProviderRegistry } from '@app/notify';

/**
 * Process-scoped notifier registry. Module-level singleton so every importer
 * inside `apps/api` sees the same registered set; the provider list mirrors
 * `apps/worker/src/notifiers.ts` because both modules call the shared
 * `buildNotifyRegistry` factory from `@app/notify`.
 */
export const notifyProviders: NotifyProviderRegistry = buildNotifyRegistry();
