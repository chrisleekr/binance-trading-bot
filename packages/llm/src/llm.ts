import { encode as toonEncode } from '@toon-format/toon';
import {
  parseImproveConfigModelOutput,
  type AiProviderConfig,
  type ImproveConfigMode,
  type ImproveConfigResponse,
} from '@app/contracts';
import type { LlmClient } from './client.js';
import { createAnthropicClient } from './providers/anthropic.js';
import { createOpenAiCompatClient } from './providers/openai-compatible.js';

/**
 * LLM-assist for the backtest advisor. Assist-only: it proposes config-change
 * suggestions but never runs anything. Construct via {@link createLlm}; when no
 * credential is configured `available` is false and the call method throws, so
 * routes 503 rather than failing silently.
 */
export interface LlmAssist {
  readonly available: boolean;
  /**
   * Advise on a single backtest: given the strategy's config schema (what may
   * change, with bounds) and the run's full context (config tested, params,
   * metrics, why-it-didn't-trade breakdown, regime split, out-of-sample
   * holdout), propose config-change suggestions as path/value patches. The
   * caller validates each patched config against the strategy schema before it
   * reaches the operator.
   */
  improveConfig(input: ImproveConfigInput, mode: ImproveConfigMode): Promise<ImproveConfigResponse>;
}

/** Inputs the advisor reads about a run: the strategy's config schema (what may
 * change, with bounds) and the run's full context (config, params, metrics,
 * why-it-didn't-trade breakdown, regime split, out-of-sample holdout). Shared by
 * the server call and the manual-prompt builder so both render the same content. */
export interface ImproveConfigInput {
  strategyName: string;
  strategyVersion: string;
  configSchema: unknown;
  context: unknown;
}

// JSON Schemas for the structured output. Each provider constrains the model to
// its shape differently (Anthropic forces a tool whose input_schema is this;
// OpenAI-compatible uses response_format json_schema), but the schema is the same.
const IMPROVE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          rationale: { type: 'string' },
          changes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              // A config value is a JSON scalar typed by the field's own
              // schema. Typing it as a scalar union (not an open `{}`) matters:
              // newer models (claude-sonnet-5) use constrained decoding and,
              // faced with an untyped field, fall back to serializing the whole
              // `suggestions` array as a string. The concrete union keeps them
              // on the structured path. This is deliberately narrower than the
              // contract's `value: z.unknown()`: server-path suggestions target
              // scalar leaves (`gridTrade[0].triggerPercentage`, not a whole
              // array). A structural whole-array/object patch would ride the
              // manual paste-back path, which parses free JSON.
              properties: {
                path: { type: 'string' },
                value: { type: ['string', 'number', 'boolean', 'null'] },
              },
              required: ['path', 'value'],
              additionalProperties: false,
            },
          },
          expectedEffect: { type: 'string' },
          overfitRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['id', 'title', 'rationale', 'changes', 'expectedEffect', 'overfitRisk'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'suggestions'],
  additionalProperties: false,
} as const;

const IMPROVE_SYSTEM =
  'You advise on tuning a spot crypto trading-strategy config after a single ' +
  'backtest. Propose concrete config changes most likely to improve REAL, ' +
  'forward performance — not the in-sample number. The live-enablement gate ' +
  'decides go-live on exactly these metrics: data coverage (no gaps), profit ' +
  'factor, closed-trade count, alpha vs hold, and the same three over the ' +
  'out-of-sample holdout. The run context carries that gate checklist with each ' +
  'pass/fail, so aim your changes at the FAILING checks first, starting with the ' +
  'binding one. Treat cagr, calmar, sharpe, sortino, and sqn as diagnostic ' +
  'context only — they annualize or need many trades, so they read as noise on ' +
  'short or thin runs and the gate ignores them; never tune to raise them. When ' +
  'the run carries data-coverage warnings, or has too few closed trades for the ' +
  'numbers to be statistically meaningful, the metrics are unreliable: say so in ' +
  '`summary` and recommend re-running on a longer, gap-free window BEFORE ' +
  'proposing config patches, rather than fitting suggestions to noise. The ' +
  "context's `tradeOrHold` is the honest baseline verdict — HOLD when the run " +
  'lost to a fee-free buy-and-hold or closed no trades; when it says hold, agree ' +
  'unless a specific, robust config change plausibly flips it. The decision ' +
  "breakdown is the strategy's own emission counters and gate logs: an `_emit` " +
  'suffix is an action taken, while `_skipped` / `_veto` / `blocked` with a ' +
  '`reason` tag is an entry or exit the strategy declined and why — read these ' +
  'to find the constraint that blocked the most entries, then tune that ' +
  'constraint. `fillRealism` records what the fill model assumed: when ' +
  '`favorableIntrabar` is true (detail interval equals the strategy interval) or ' +
  '`spreadBps` / `volumeCapPct` are null (not modeled), intra-candle fills are ' +
  'optimistic — discount round-trip profits that depend on precise entry or exit ' +
  'within one bar, especially for tight grids. Only recommend a finer detail ' +
  'interval when `fillRealism.finerDetailAvailable` is true; when it is false the ' +
  'strategy already runs at the finest supported interval, so optimistic ' +
  'intra-candle fills are inherent and cannot be tuned away — treat them as a ' +
  'caveat on the numbers, not a fixable setting. Justify each change from the ' +
  'run: a decision breakdown that shows a constraint blocked many entries, a ' +
  'regime split, the out-of-sample holdout, the downsampled equity/drawdown ' +
  'curves (long flat stretches mean capital sat idle while the market moved), and ' +
  'the exit-reason mix (which mechanism closed positions — a premature ' +
  'technicals force-sell drag is very different from trailing-stop exits). Prefer changes whose benefit holds ' +
  'across regimes and the holdout; a gain visible only in-sample is overfitting ' +
  '— flag it via overfitRisk and prefer not to suggest it. Never recommend ' +
  'disabling the bearish technical-rating veto or otherwise buying into a ' +
  'downtrend. Emit each change as path/value patches against the provided config ' +
  'schema, using only existing field paths and values within documented bounds. ' +
  'Field descriptions may carry UI display hints (text prefixed `@ui:`) and may ' +
  'quote example values on the DISPLAY scale, not the stored scale; emit every ' +
  'value in the stored units the schema defines. A percent or fraction field is a ' +
  'decimal in its documented range — commonly (0, 1], so half is 0.5, NOT 50 — ' +
  'even when the description says e.g. "50 keeps about half". When the scale or ' +
  'bound of a field is unclear, leave it unchanged rather than guess. ' +
  'If the honest read is that no change beats holding cash, say so in `summary` ' +
  'and return few or no suggestions. You advise; the operator reviews, re-runs, ' +
  'and the out-of-sample gate still decides go-live.';

// EXPLORE mode: the operator has opted into bold, higher-variance ideas. Same
// hard guardrails as the safe prompt (bearish veto, documented bounds, stored
// units, data-first honesty, the out-of-sample gate), but it PROPOSES rather than
// withholds — bold changes are framed as hypotheses to test on a re-run, and
// sizing is allowed only with the honest caveat that it amplifies edge, never
// creates it. The shared base for every non-`safe` variant; `systemForMode`
// appends the variant's `VARIANT_FOCUS` steering.
const IMPROVE_SYSTEM_BOLD =
  'You advise on tuning a spot crypto trading-strategy config after a single ' +
  'backtest, in EXPLORE mode: the operator has explicitly asked for bold, ' +
  'higher-variance ideas, so propose 2 to 4 concrete changes worth TESTING even ' +
  'when the safe read is to hold — each is a HYPOTHESIS to validate on a re-run, ' +
  'never a validated fix, and the out-of-sample gate still decides go-live. Lean ' +
  'into what the run shows: if a tight trailing stop or profit trigger cut ' +
  'winners short while a trend ran past (a flat equity curve against a large ' +
  'marketChangePct, exits dominated by grid-sell or technicals-force-sell), give ' +
  'winners more room; if entries were starved (few buys against many pure-path ' +
  'ticks), loosen the entry structure. You MAY change any config field within its ' +
  'documented bounds, including the candle interval and position sizing. Be honest ' +
  'about sizing: a larger position (maxPurchaseAmount or risk per trade) AMPLIFIES ' +
  'whatever edge exists and does not create it — on a run that lost to buy-and-hold, ' +
  'sizing up only scales the loss, so propose it only with that caveat and never as ' +
  'a path to positive alpha. Flag every bold change with an honest overfitRisk of ' +
  'medium or high. When the run carries data-coverage warnings or too few closed ' +
  'trades to be statistically meaningful, the metrics are noise: say so FIRST in ' +
  '`summary` and recommend re-running on a longer, gap-free window before trusting ' +
  'any hypothesis — explore mode changes WHAT you propose, not whether the data can ' +
  'be trusted. When the useful next step is a wide search across many ' +
  'configurations rather than a few directed edits, say so rather than forcing it ' +
  'into patches. The ' +
  'live gate still scores data coverage, profit factor, closed trades, alpha vs ' +
  'hold, and the same over the holdout; treat cagr/calmar/sharpe/sortino/sqn as ' +
  'diagnostic only, never a tuning target. Never recommend disabling the bearish ' +
  'technical-rating veto or otherwise buying into a downtrend, and do not propose a ' +
  'finer detail interval when `fillRealism.finerDetailAvailable` is false. Emit ' +
  'each change as path/value patches against the provided config schema, using only ' +
  'existing field paths and values within documented bounds, every value in the ' +
  'stored units the schema defines (a percent or fraction field is a decimal in its ' +
  'documented range, commonly (0, 1], so half is 0.5, NOT 50). You advise; the ' +
  'operator reviews, re-runs, and the out-of-sample gate still decides go-live.';

// Per-variant focus appended to the shared EXPLORE base, so each button steers the
// same bold advisor at a different lever without duplicating the guardrails.
const VARIANT_FOCUS: Record<Exclude<ImproveConfigMode, 'safe'>, string> = {
  'ride-trend':
    'Focus this pass on letting winners run: loosen trailing stops, profit ' +
    'triggers, and hold-in-uptrend settings so the strategy captures more of a ' +
    'trend it currently exits early. Leave entry gates and the bearish veto alone.',
  'trade-more':
    "Focus this pass on raising the closed-trade count toward the gate's floor: " +
    'loosen entry throttles, regime exposure scalars, and grid spacing so more ' +
    'entries fire — without relaxing the bearish veto or buying into a downtrend.',
  aggressive:
    'Focus this pass on higher-conviction, higher-variance changes: larger ' +
    'position sizing and exposure, and wider grids. Be explicit that sizing ' +
    'amplifies losses as well as gains and is not a path to alpha.',
  defensive:
    'Focus this pass on cutting drawdown and downside: tighter protective and ' +
    'break-even stops, smaller sizing, and faster exits on weakness, accepting ' +
    'that some upside is given up.',
};

/** Pick the advisor system prompt: the honest SAFE prompt, or the shared EXPLORE
 * base steered by the requested variant's focus. */
const systemForMode = (mode: ImproveConfigMode): string =>
  mode === 'safe' ? IMPROVE_SYSTEM : `${IMPROVE_SYSTEM_BOLD} ${VARIANT_FOCUS[mode]}`;

// The user message for improve-config: strategy + config schema + run context.
// Shared by the server tool-call path and the manual prompt so both carry the
// identical content; only the output mechanism differs (forced tool vs. an
// inline "return JSON" instruction).
const improveConfigUserContent = (input: ImproveConfigInput): string =>
  `Strategy ${input.strategyName}@${input.strategyVersion}.\n\n` +
  // Config schema stays JSON: it is a nested, irregular JSON Schema, the one
  // shape TOON encodes LARGER than JSON (measured +23% tokens). The run context
  // is TOON: its bulk is uniform arrays (equity/drawdown curves, round-trips,
  // regime split, gate checks) that TOON's tabular header+rows compress ~24%.
  `Config schema (the fields you may change, with documented types and bounds):\n${JSON.stringify(input.configSchema)}\n\n` +
  'The backtest that ran, encoded as TOON (a compact JSON-equivalent: a uniform ' +
  'array of objects is `name[COUNT]{field1,field2,...}:` then one indented ' +
  'comma-separated row per element; an array of scalars is `name[COUNT]: ' +
  'v1,v2,...` on one line; a non-uniform array uses `- ` list items; nested ' +
  'objects use indentation; values carry the same meaning as JSON). Sections: ' +
  'config tested, parameters, metrics, live-gate checklist, data-coverage ' +
  "warnings, trade-or-hold baseline, fill-model realism, why-it-didn't-trade " +
  'breakdown, regime split, out-of-sample holdout, round-trip sample.\n' +
  `${toonEncode(input.context)}`;

/**
 * Render the improve-config prompt for manual use: the operator copies it into
 * claude.ai (where a Pro/Max subscription works), gets a JSON reply, and pastes
 * it back for the route to validate. Same system text and run context as
 * {@link LlmAssist.improveConfig}; the forced tool call becomes an explicit
 * "return JSON matching this schema" instruction, since the chat UI has no
 * tool-call mechanism. Pure string building — needs no API key, so the route
 * serves it even when server-side assist is disabled.
 */
export function buildImproveConfigManualPrompt(
  input: ImproveConfigInput,
  mode: ImproveConfigMode,
): string {
  return [
    systemForMode(mode),
    '',
    improveConfigUserContent(input),
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences — matching this JSON Schema:',
    JSON.stringify(IMPROVE_SCHEMA),
  ].join('\n');
}

/** Build the provider client for the selected backend. */
const clientForConfig = (config: AiProviderConfig): LlmClient =>
  config.provider === 'anthropic'
    ? createAnthropicClient(config.anthropic)
    : createOpenAiCompatClient(config.openai);

/**
 * Assemble the assist over whichever provider the config selects. The method
 * builds a system prompt + user message + output schema and delegates to the
 * provider client's `generateStructured`, then zod-parses — so prompt text, TOON
 * encoding, and validation are written once, provider-agnostic. When the selected
 * provider has no usable credential/config, `available` is false and the method
 * async-rejects (routes 503 rather than failing silently).
 */
export function createLlm(config: AiProviderConfig): LlmAssist {
  const client = clientForConfig(config);
  if (!client.available) {
    const unavailable = async (): Promise<never> => {
      throw new Error('llm assist not configured (set an AI provider in Settings)');
    };
    return {
      available: false,
      improveConfig: unavailable,
    };
  }

  return {
    available: true,
    async improveConfig(input, mode) {
      const out = await client.generateStructured({
        name: 'suggest_config_changes',
        description:
          'Suggest config changes as path/value patches, each with a rationale and an overfit-risk flag.',
        systemText: systemForMode(mode),
        user: improveConfigUserContent(input),
        // A full answer is up to ~10 suggestions with rationales; 2048 truncated
        // the verbose models mid-JSON. Output is billed per generated token, so the
        // higher cap only costs the tokens used while removing the truncation failure.
        schema: IMPROVE_SCHEMA,
        maxTokens: 8192,
      });
      return parseImproveConfigModelOutput(out);
    },
  };
}
