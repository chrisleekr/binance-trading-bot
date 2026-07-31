import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, StructuredRequest } from '../client.js';

/**
 * How the client authenticates. `apikey` uses a Console `sk-ant-api-...` key via
 * the `x-api-key` header; `oauth` uses a Claude Code subscription `sk-ant-oat-...`
 * token via `Authorization: Bearer`. The two are not interchangeable — passing an
 * OAuth token as an API key 401s.
 */
type AuthMode = 'apikey' | 'oauth';

/**
 * Anthropic gates `sk-ant-oat-...` OAuth tokens to a throttled quota pool unless
 * the FIRST system block is exactly this string. Without it, Sonnet/Opus return
 * 429 rate_limit_error. The gate is an exact match on the whole first block, so
 * the identifier must stand alone as block 0 (array form) with the caller's real
 * system text following as block 1. Console API keys are unaffected.
 */
export const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Shape the `system` field. The caller's text always carries `cache_control` so
 * repeat calls stay cheap. On the OAuth path, prepend the Claude Code identifier
 * as a standalone first block (see {@link CLAUDE_CODE_IDENTIFIER}).
 *
 * @internal exported for tests only.
 */
export function buildSystemBlocks(
  authMode: AuthMode,
  callerText: string,
): Anthropic.TextBlockParam[] {
  const callerBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: callerText,
    cache_control: { type: 'ephemeral' },
  };
  if (authMode === 'apikey') return [callerBlock];
  return [{ type: 'text', text: CLAUDE_CODE_IDENTIFIER }, callerBlock];
}

const firstToolInput = (message: Anthropic.Message): unknown => {
  // A max_tokens cutoff yields a truncated tool input that fails schema parse
  // with an opaque message; surface the real cause so the operator can retry.
  if (message.stop_reason === 'max_tokens') {
    throw new Error('llm: response truncated at max_tokens');
  }
  const block = message.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') {
    throw new Error('llm: model did not return the forced tool call');
  }
  return block.input;
};

/**
 * Native Anthropic client. Structured output is obtained by forcing a single tool
 * call (`tool_choice`) whose `input_schema` is the requested JSON Schema, then
 * reading the `tool_use` input — the reliable path to validated JSON on Anthropic.
 * `@anthropic-ai/sdk` is a large dependency imported lazily on first call and
 * memoised, so an app with assist disabled never loads it.
 */
export function createAnthropicClient(opts: {
  apiKey: string;
  oauthToken: string;
  model: string;
}): LlmClient {
  const apiKey = opts.apiKey.trim();
  const oauthToken = opts.oauthToken.trim();
  const available = Boolean(apiKey || oauthToken);
  if (!available) {
    return {
      available: false,
      generateStructured: async () => {
        throw new Error('llm: anthropic provider has no credential');
      },
    };
  }
  // Prefer the Console API key when both are set: it's the supported path with
  // real quota. OAuth (Bearer) is the subscription fallback needing the identifier block.
  const authMode: AuthMode = apiKey ? 'apikey' : 'oauth';
  type AnthropicClient = InstanceType<typeof import('@anthropic-ai/sdk').default>;
  let clientPromise: Promise<AnthropicClient> | null = null;
  const getClient = (): Promise<AnthropicClient> => {
    clientPromise ??= import('@anthropic-ai/sdk').then((m) =>
      authMode === 'apikey' ? new m.default({ apiKey }) : new m.default({ authToken: oauthToken }),
    );
    return clientPromise;
  };

  return {
    available: true,
    async generateStructured(req: StructuredRequest): Promise<unknown> {
      const client = await getClient();
      const tool: Anthropic.Tool = {
        name: req.name,
        description: req.description ?? req.name,
        // The SDK types input_schema as its own JSON-Schema shape; the request's
        // `object` schema is structurally that. One cast at the boundary.
        input_schema: req.schema as Anthropic.Tool.InputSchema,
      };
      // Stream even though no caller reads progress: a streamed request keeps the
      // socket busy end-to-end (a full answer can take ~30s), so it never trips an
      // idle timeout at an intermediary. `finalMessage()` yields the same complete
      // message a non-streamed call would; harmless for the short calls too.
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: req.maxTokens,
        system: buildSystemBlocks(authMode, req.systemText),
        tools: [tool],
        tool_choice: { type: 'tool', name: req.name },
        messages: [{ role: 'user', content: req.user }],
      });
      return firstToolInput(await stream.finalMessage());
    },
  };
}
