import type { LlmClient, StructuredRequest } from '../client.js';

/** Hard ceiling on a single request so a hung/slow local model can't wedge a synchronous route. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Generic client for any endpoint speaking the OpenAI Chat Completions API:
 * Ollama (the documented default), vLLM, LM Studio, OpenRouter, OpenAI. Structured
 * output uses `response_format: { type: 'json_schema' }` — the portable mechanism,
 * since Ollama's OpenAI-compat endpoint does not support `tool_choice` (so a forced
 * tool call is not an option off Anthropic). Hand-rolled `fetch` keeps this free of
 * an extra SDK dependency.
 *
 * `strict` is left off: the existing assist schemas are not in OpenAI's strict-mode
 * subset (optional fields, no `additionalProperties:false`), and Ollama honours
 * `json_schema` regardless, so non-strict is the portable choice. The endpoint must
 * support `response_format: { type: 'json_schema' }`.
 */
export function createOpenAiCompatClient(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): LlmClient {
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = opts.apiKey.trim();
  const model = opts.model.trim();
  const available = Boolean(baseUrl && model);
  if (!available) {
    return {
      available: false,
      generateStructured: async () => {
        throw new Error('llm: openai-compatible provider needs a base URL and model');
      },
    };
  }

  return {
    available: true,
    async generateStructured(req: StructuredRequest): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      // Keep the timer armed until the body is fully read: `fetch` resolves on
      // response headers, so the abort must still be able to fire during
      // `res.text()`/`res.json()` — a server that stalls the body would otherwise
      // hang past the ceiling. Hence the body reads live inside this try/finally.
      try {
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              max_tokens: req.maxTokens,
              messages: [
                { role: 'system', content: req.systemText },
                { role: 'user', content: req.user },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: { name: req.name, schema: req.schema },
              },
            }),
          });
        } catch (err) {
          // AbortError (timeout) or a connection failure at the header phase.
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`llm: openai-compatible request failed (${reason})`);
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`llm: openai-compatible ${res.status} ${res.statusText} ${body}`.trim());
        }
        const payload = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          throw new Error('llm: openai-compatible response had no message content');
        }
        // Fail honestly on malformed JSON (parity with Anthropic's schema-parse
        // throw): the operator regenerates or uses the manual path.
        return JSON.parse(content);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
