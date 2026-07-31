// Public surface of @app/notify. The contract types and the registry are the
// only things apps consume; individual provider implementations stay reachable
// via the `./providers/*` subpath exports so the plugin-leak gate
// (`scripts/ci/no-plugin-leak.sh`) can keep apps off them outside their
// registry bootstrap.

export type {
  NotifyProvider,
  NotifyMessage,
  NotifyField,
  NotifySeverity,
  AnyNotifyProvider,
  NotifyProviderDescriptor,
  NotifyProviderRegistry,
} from './contract.js';

export { createNotifyRegistry, NotifyProviderContractError } from './contract.js';
export { messageParts } from './format.js';
export type { MessageParts } from './format.js';
export { buildNotifyRegistry } from './registry.js';
