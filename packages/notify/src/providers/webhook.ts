// Generic Webhook notify provider — POST JSON to a configurable URL.
//
// Config:
//   { url: string, method?: 'POST' | 'PUT', authHeader?: string }

import { z } from 'zod';
import type { NotifyProvider } from '../contract.js';

/** Generic webhook config; `authHeader`, when present, carries a bearer secret. */
export const WebhookConfigSchema = z.object({
  url: z
    .url()
    .describe('HTTPS endpoint that receives a JSON request carrying the notification payload.'),
  method: z
    .enum(['POST', 'PUT'])
    .optional()
    .describe('HTTP method for the request. Defaults to POST.'),
  authHeader: z
    .string()
    .optional()
    .describe(
      'Optional value sent as the Authorization header, e.g. "Bearer <token>". Leave blank for an unauthenticated endpoint.',
    ),
});

/**
 * Compile-time mirror of {@link WebhookConfigSchema}. Pinned to `z.infer<>`
 * so the type cannot drift from the runtime validator: any change to the
 * schema (e.g. `method` enum widening) propagates here on the next typecheck.
 */
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

/** Lets tests swap `fetchImpl` for offline runs. */
export interface WebhookProviderOptions {
  readonly fetchImpl?: typeof fetch;
}

/**
 * Factory so tests can swap `fetchImpl`. The exported `webhookProvider`
 * calls this with no overrides for production.
 */
export const createWebhookProvider = (
  opts: WebhookProviderOptions = {},
): NotifyProvider<WebhookConfig> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    name: 'webhook',
    version: '1.0.0',
    displayName: 'Generic Webhook',
    secretFields: ['authHeader'],
    configSchema: WebhookConfigSchema,
    async send({ config, message }) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.authHeader) headers['Authorization'] = config.authHeader;
      const res = await fetchImpl(config.url, {
        method: config.method ?? 'POST',
        // Machine endpoint: emit the structured envelope verbatim (title,
        // profile, symbol, body, fields) so a downstream consumer parses typed
        // fields instead of a re-serialised blob.
        body: JSON.stringify({ ...message, ts: Date.now() }),
        headers,
      });
      if (!res.ok) {
        throw new Error(`Webhook failed: ${res.status} ${res.statusText}`);
      }
    },
  };
};

/** Production singleton bound to the platform `fetch`. */
export const webhookProvider = createWebhookProvider();
