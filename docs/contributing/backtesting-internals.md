# Backtesting internals

Contributor notes for the backtesting engine: where the code lives and one recorded deviation from the repo's charting default. For the operator-facing explanation of how a backtest works and what the results mean, see [Backtesting](../concepts/backtesting.md) and the [Backtest metrics reference](../concepts/backtest-metrics.md).

## Recorded deviation — charting library

The equity and drawdown curves render with **lightweight-charts** area series (`apps/web/src/features/backtest/components/equity-area-chart.tsx`), not the charter's Recharts default for non-financial charts. This is deliberate: it reuses the candle chart's dynamic-import seam so the roughly 200 kB charting bundle loads only when a result is viewed, and avoids pulling in a second charting dependency. Noted here so the charter and the shipped code agree.

## Where the code lives

The in-repo packages are the source of truth for everything the feature pages describe:

- `packages/strategy/backtest/` — the pure engine: `runBacktest`, the `BacktestExecutor`, the fill models, and the metrics.
- `apps/worker/src/backtest/` — orchestration: candle backfill + the runner that maps a profile to an engine run.
- `apps/api/src/routes/backtests.ts` — enqueue + poll.
- `apps/web/src/features/backtest/` — the launch form and results view.

## Backtest advisor internals

Implementation detail behind the improve-config advisor. The operator-facing behaviour lives in the [Backtest metrics reference](../concepts/backtest-metrics.md).

**Prompt encoding.** The run context is serialised to the prompt as **TOON** (Token-Oriented Object Notation, `@toon-format/toon`), not JSON: its bulk is uniform arrays (equity/drawdown curves, round-trips, regime split, gate checks) whose tabular `header + rows` form measures about 24% fewer input tokens than JSON on a representative run. The **config schema stays JSON** — it is a nested, irregular JSON Schema, the one shape TOON encodes larger than JSON — so the two are encoded by their best-fit format. The model's output is unaffected: it still returns JSON.

**Provider seam.** The advisor drives the `LlmAssist` seam in the `@app/llm` package, which sits on a provider-agnostic `LlmClient.generateStructured` primitive (`packages/llm/src/client.ts`): the **Anthropic** adapter forces a single tool call, while the **OpenAI-compatible** adapter (Ollama, vLLM, OpenAI) uses `response_format: json_schema` — Ollama's OpenAI-compat endpoint does not support `tool_choice`, so `response_format` is the portable path.

**Manual loop routes.** For the Anthropic provider the server path accepts either a Console API key or a Claude Code subscription OAuth token (used only when the key is blank); the OAuth path drives the Messages API via `Authorization: Bearer`, gated by the Claude Code identifier as the first system block (a subscription token is outside the Messages API's intended scope and may be rate-limited, so the Console key is the supported path). The "Run it myself" button uses `GET …/advisor/manual/prompt`, which returns the exact prompt (built by the same `buildImproveConfigManualPrompt` the server would send, minus the forced tool — an inline "return JSON matching this schema" instruction stands in); the operator pastes the model reply into `POST …/advisor/manual`, which extracts the JSON (tolerating prose/markdown fences; `422` if none), applies the same strategy-schema re-validation as the server call, and persists to the run's own `manual` slot. Neither route needs a server-side credential, so neither `503`s.
