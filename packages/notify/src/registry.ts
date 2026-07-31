import { createNotifyRegistry, type NotifyProviderRegistry } from './contract.js';
import { slackProvider } from './providers/slack.js';
import { telegramProvider } from './providers/telegram.js';
import { webhookProvider } from './providers/webhook.js';

/**
 * Single source of truth for the registered notifier provider set. apps/api
 * and apps/worker each call this at boot so `describeAll()` is identical in
 * both processes without a custom lint rule diffing two bootstrap files.
 */
export const buildNotifyRegistry = (): NotifyProviderRegistry => {
  const registry = createNotifyRegistry();
  registry.register(slackProvider);
  registry.register(telegramProvider);
  registry.register(webhookProvider);
  return registry;
};
