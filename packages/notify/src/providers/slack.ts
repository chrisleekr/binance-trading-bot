// Slack notify provider — Incoming Webhook URL.
//
// Config:
//   { webhookUrl: string, channel?: string, username?: string }
//
// Source: https://api.slack.com/messaging/webhooks

import { z } from 'zod';
import type { NotifyMessage, NotifyProvider } from '../contract.js';
import { messageParts } from '../format.js';

/** Per-profile Slack config; `webhookUrl` is the only true secret. */
export const SlackConfigSchema = z.object({
  webhookUrl: z
    .url()
    .describe(
      'Slack Incoming Webhook URL (https://hooks.slack.com/services/...). Create one under api.slack.com → Incoming Webhooks. Anyone with this URL can post to the channel, so keep it secret.',
    ),
  channel: z
    .string()
    .optional()
    .describe(
      'Optional channel override, e.g. #alerts. Leave blank to use the channel the webhook was created for.',
    ),
  username: z
    .string()
    .optional()
    .describe('Optional sender name shown on each message, e.g. trading-bot.'),
});

/**
 * Compile-time mirror of {@link SlackConfigSchema}. Pinned to `z.infer<>` so
 * the type cannot drift from the runtime validator: any field added or
 * tightened in the schema appears here on the next typecheck.
 */
export type SlackConfig = z.infer<typeof SlackConfigSchema>;

/** Lets tests inject a mock `fetch`; production wires the platform `fetch`. */
export interface SlackProviderOptions {
  readonly fetchImpl?: typeof fetch;
}

/**
 * Factory rather than singleton so tests can swap `fetchImpl`. The exported
 * `slackProvider` calls this with no overrides for production.
 */
export const createSlackProvider = (
  opts: SlackProviderOptions = {},
): NotifyProvider<SlackConfig> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    name: 'slack',
    version: '1.0.0',
    displayName: 'Slack (Incoming Webhook)',
    secretFields: ['webhookUrl'],
    configSchema: SlackConfigSchema,
    async send({ config, message }) {
      const text = formatText(message);
      const body: Record<string, unknown> = { text };
      if (config.channel) body['channel'] = config.channel;
      if (config.username) body['username'] = config.username;
      const res = await fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Slack webhook failed: ${res.status} ${res.statusText}`);
      }
    },
  };
};

/** Escape the characters Slack treats as markup control in message text. */
const mrkdwnEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatText = (message: NotifyMessage): string => {
  const prefix =
    message.severity === 'error'
      ? ':rotating_light:'
      : message.severity === 'warn'
        ? ':warning:'
        : ':information_source:';
  const parts = messageParts(message);
  const lines: string[] = [`${prefix} *${mrkdwnEscape(parts.title)}*`];
  if (parts.context) lines.push(mrkdwnEscape(parts.context));
  if (parts.body) lines.push('', mrkdwnEscape(parts.body));
  if (parts.fields.length > 0) {
    lines.push('');
    for (const f of parts.fields) {
      lines.push(`• *${mrkdwnEscape(f.label)}:* ${mrkdwnEscape(f.value)}`);
    }
  }
  // Slack link syntax is <url|text>; percent-encode the two control characters
  // that would otherwise terminate the link or split url/label. Links are
  // worker-built from a validated base URL today; this keeps the sink robust
  // against the open-string `link` contract.
  if (parts.link) {
    const url = parts.link.replace(/>/g, '%3E').replace(/\|/g, '%7C');
    lines.push('', `<${url}|Open →>`);
  }
  return lines.join('\n');
};

/** Production singleton bound to the platform `fetch`. */
export const slackProvider = createSlackProvider();
