// Telegram notify provider — Bot API.
//
// Config:
//   { botToken: string, chatId: string | number }
//
// Source: https://core.telegram.org/bots/api#sendmessage

import { z } from 'zod';
import type { NotifyMessage, NotifyProvider } from '../contract.js';
import { messageParts } from '../format.js';

/** Per-profile Telegram config; `botToken` is the only true secret. */
export const TelegramConfigSchema = z.object({
  botToken: z
    .string()
    .min(1)
    .describe(
      'Bot token from @BotFather (e.g. 123456:ABC-DEF...). Send /newbot to @BotFather in Telegram to create a bot and copy its token.',
    ),
  chatId: z
    .union([z.string(), z.number()])
    .describe(
      'Chat to send to. Message @userinfobot for your personal numeric ID; for a group, add the bot and use the group ID (often negative).',
    ),
});

/**
 * Compile-time mirror of {@link TelegramConfigSchema}. Pinned to `z.infer<>`
 * so the type cannot drift from the runtime validator: any change to schema
 * (new field, narrowed `chatId` union) flows here on the next typecheck.
 */
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

/** Lets tests swap `fetchImpl` and the api base for offline runs. */
export interface TelegramProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly apiBase?: string;
}

/**
 * Factory so tests can swap `fetchImpl`/`apiBase`. The exported
 * `telegramProvider` calls this with no overrides for production.
 */
export const createTelegramProvider = (
  opts: TelegramProviderOptions = {},
): NotifyProvider<TelegramConfig> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? 'https://api.telegram.org';
  return {
    name: 'telegram',
    version: '1.0.0',
    displayName: 'Telegram (Bot API)',
    secretFields: ['botToken'],
    configSchema: TelegramConfigSchema,
    async send({ config, message }) {
      const url = `${apiBase}/bot${config.botToken}/sendMessage`;
      const text = formatText(message);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          // HTML, not legacy Markdown: dynamic content (error strings, symbols)
          // can contain `_` `*` `` ` `` that make Markdown 400 with "can't parse
          // entities" and drop the message. HTML needs only `&<>` escaped
          // (htmlEscape below), so no operator text can ever break parsing.
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText}`);
      }
    },
  };
};

/** Escape the three characters that are significant in Telegram HTML text nodes. */
const htmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Escape for a double-quoted HTML attribute value: text-node escaping plus `"`,
 * which would otherwise close the attribute early. Links are worker-built from a
 * validated base URL today, but the `link` contract is an open string, so the
 * href sink is escaped for its own context.
 */
const attrEscape = (s: string): string => htmlEscape(s).replace(/"/g, '&quot;');

const formatText = (message: NotifyMessage): string => {
  const prefix = message.severity === 'error' ? '🚨' : message.severity === 'warn' ? '⚠️' : 'ℹ️';
  const parts = messageParts(message);
  const lines: string[] = [`${prefix} <b>${htmlEscape(parts.title)}</b>`];
  if (parts.context) lines.push(htmlEscape(parts.context));
  if (parts.body) lines.push('', htmlEscape(parts.body));
  if (parts.fields.length > 0) {
    lines.push('');
    for (const f of parts.fields) {
      lines.push(`• <b>${htmlEscape(f.label)}:</b> ${htmlEscape(f.value)}`);
    }
  }
  if (parts.link) lines.push('', `<a href="${attrEscape(parts.link)}">Open →</a>`);
  return lines.join('\n');
};

/** Production singleton bound to the public Bot API base. */
export const telegramProvider = createTelegramProvider();
