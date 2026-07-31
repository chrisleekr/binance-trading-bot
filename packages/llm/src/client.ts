/**
 * The one primitive every provider implements: given a system prompt, a user
 * message, and a JSON Schema, return a JSON value that satisfies the schema. How
 * that constraint is enforced is provider-specific — Anthropic forces a single
 * tool call; OpenAI-compatible endpoints use `response_format: json_schema` — but
 * the seam hides that. The `improveConfig` assist method builds a request, calls
 * this, and zod-parses the result, so all prompt/TOON/parse logic is written once
 * regardless of provider.
 */
export interface StructuredRequest {
  /** Schema/tool name: `[a-zA-Z0-9_-]{1,64}`. Anthropic tool name; OpenAI `json_schema.name`. */
  readonly name: string;
  /** Optional task guidance (Anthropic tool description). Ignored by providers that have no slot for it. */
  readonly description?: string;
  readonly systemText: string;
  readonly user: string;
  /** JSON Schema the returned value must satisfy. */
  readonly schema: object;
  readonly maxTokens: number;
}

export interface LlmClient {
  /** False when no usable credential/config for the selected provider; methods then reject. */
  readonly available: boolean;
  /** Returns a JSON value matching `req.schema`. Throws on transport error, truncation, or unparseable output. */
  generateStructured(req: StructuredRequest): Promise<unknown>;
}
