import { buildNotifyRegistry, type NotifyProviderRegistry } from '@app/notify';

/** Process-scoped notifier registry; shared bootstrap with apps/api via @app/notify. */
export const notifyProviders: NotifyProviderRegistry = buildNotifyRegistry();
