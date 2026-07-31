import { z } from 'zod';

/**
 * Which backend serves the AI-assist features (advisor). `anthropic`
 * is the native path (forced tool calls); `openai-compatible` is any endpoint
 * speaking the OpenAI Chat Completions API with `response_format` structured
 * output — Ollama (the documented default), vLLM, LM Studio, OpenRouter, OpenAI.
 */
export const AiProvider = z.enum(['anthropic', 'openai-compatible']);
export type AiProvider = z.infer<typeof AiProvider>;

/**
 * Full resolved provider config, secrets included. Read from the DB singleton and
 * handed to `createLlm`; never serialized to the wire (see {@link AiProviderConfigView}).
 * Empty strings mean "not set" — the llm factory decides `available` from them.
 */
export const AiProviderConfig = z.object({
  provider: AiProvider,
  anthropic: z.object({
    apiKey: z.string(),
    oauthToken: z.string(),
    model: z.string(),
  }),
  openai: z.object({
    baseUrl: z.string(),
    apiKey: z.string(),
    model: z.string(),
  }),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfig>;

/**
 * `GET /account/ai-provider`. The wire-safe projection: secrets are replaced by
 * `has*` booleans so a key is never sent back to the browser, mirroring how
 * `profile_notifiers.secrets` is stripped. Non-secret fields (model, base URL)
 * round-trip as-is so the form can prefill them.
 */
export const AiProviderConfigView = z.object({
  provider: AiProvider,
  anthropic: z.object({
    model: z.string(),
    hasApiKey: z.boolean(),
    hasOauthToken: z.boolean(),
  }),
  openai: z.object({
    baseUrl: z.string(),
    model: z.string(),
    hasApiKey: z.boolean(),
  }),
});
export type AiProviderConfigView = z.infer<typeof AiProviderConfigView>;

/**
 * `PATCH /account/ai-provider` body. Secret fields are optional and a blank/omitted
 * value means "leave the stored secret unchanged", so the UI never has to receive a
 * secret just to re-submit it. Lengths bound fat-fingered input at the edge; the
 * `available` check (has a usable credential for the chosen provider) lives in the
 * llm factory, so partially-filled configs persist without a 422.
 */
export const AiProviderConfigUpdate = z.object({
  provider: AiProvider,
  anthropic: z.object({
    model: z.string().min(1).max(128),
    apiKey: z.string().max(512).optional(),
    oauthToken: z.string().max(512).optional(),
  }),
  openai: z.object({
    // Fetched server-side, so bound the scheme to http(s) — rejects file:/gopher:
    // and other SSRF-flavoured schemes. Empty is allowed (provider may be anthropic).
    baseUrl: z
      .string()
      .max(2048)
      .refine(
        (v) => v === '' || /^https?:\/\//i.test(v),
        'base URL must start with http:// or https://',
      ),
    model: z.string().max(128),
    apiKey: z.string().max(512).optional(),
  }),
});
export type AiProviderConfigUpdate = z.infer<typeof AiProviderConfigUpdate>;

/**
 * `POST /account/ai-provider/test` result: whether the configured endpoint answered
 * a lightweight reachability probe, plus a short human-readable detail for the toast
 * (model list size, HTTP status, or the connection error).
 */
export const AiProviderTestResult = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type AiProviderTestResult = z.infer<typeof AiProviderTestResult>;
