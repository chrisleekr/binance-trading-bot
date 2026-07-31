import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import type { AdvisorVariant, ConfigSuggestion, ImproveConfigMode } from '@app/contracts';

import { Button } from '@/shared/components/ui/button';
import { ApiError, errorMessage } from '@/shared/lib/api';
import {
  fetchImproveConfigPrompt,
  parseImproveConfigReply,
} from '@/features/backtest/api/backtest';
import { useAdvisorRunStatus } from '@/features/backtest/lib/use-advisor-run-status';
import {
  applyRecommendations,
  configSuggestionsToRecommendations,
} from '@/features/backtest/lib/decision-breakdown';

export interface BacktestLlmAdvisorProps {
  readonly profileId: string;
  readonly runId: string;
  /** The config that produced this run — the base the chosen patches compose onto. */
  readonly config: Record<string, unknown>;
  /**
   * Load the composed config (base + the selected suggestions) into the Setup
   * form. Same loop as the rule-based panel: never writes live config, never
   * runs — the operator reviews, runs it, and the out-of-sample gate still
   * stands before "Apply to live".
   */
  readonly onApply: (nextConfig: Record<string, unknown>) => void;
}

const RISK_TINT: Record<ConfigSuggestion['overfitRisk'], string> = {
  low: 'text-up',
  medium: 'text-warning',
  high: 'text-down',
};

// The five server-generated variants, in button order. `safe` is the honest
// default; the rest are EXPLORE lenses that steer the same bold advisor at a
// different lever. `manual` is not here — it has no button, only a result slot.
const VARIANT_LABEL: Record<ImproveConfigMode, string> = {
  safe: 'Safe',
  'ride-trend': 'Ride the trend',
  'trade-more': 'Trade more',
  aggressive: 'Aggressive',
  defensive: 'Defensive',
};
const VARIANTS = Object.keys(VARIANT_LABEL) as ImproveConfigMode[];

// The copy every slot shows for the label above its result.
const SLOT_LABEL: Record<AdvisorVariant, string> = { ...VARIANT_LABEL, manual: 'Run it myself' };

const NOT_CONFIGURED_NOTE =
  'AI suggestions are not configured. Pick a provider in Account → AI assistant, or use “Run it myself” to copy the prompt into your AI chat.';

/**
 * On-demand config advisor for a finished run, backed by durable per-(run,
 * variant) rows. A reload rehydrates saved variants with no fresh model call.
 * Two entry points feed one review→load loop:
 *  - The variant buttons enqueue a background generation on the study worker
 *    (needs a configured AI provider; 503 → inline note);
 *    the row polls `running` → `done`.
 *  - "Run it myself" is the manual loop for an operator who configures no
 *    server-side provider: it shows the exact prompt to copy into an AI chat
 *    and a box to paste the reply back, persisted to the `manual` slot.
 * Either source yields the same suggestion cards; the operator multi-selects and
 * loads them into Setup. Nothing touches live config, and the out-of-sample gate
 * still decides go-live.
 */
export function BacktestLlmAdvisor({
  profileId,
  runId,
  config,
  onApply,
}: BacktestLlmAdvisorProps): React.JSX.Element {
  const advisor = useAdvisorRunStatus(profileId, runId);

  // Which slot's result is on screen. Not derived from a mutation: a persisted
  // row has no `mutation.variables`, so the shown variant is explicit state.
  const [selectedVariant, setSelectedVariant] = useState<AdvisorVariant | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [manualOpen, setManualOpen] = useState(false);
  const [reply, setReply] = useState('');

  // Rehydrate: on the first load that carries any saved row, display the most
  // recently updated terminal one so a reload shows saved work immediately. The
  // ref makes this fire once — it must not fight the operator's later navigation
  // (e.g. after they click "Ask a different variant" back to the grid).
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || selectedVariant !== null || advisor.results.length === 0) return;
    didAutoSelect.current = true;
    const terminal = advisor.results
      .filter((r) => r.status !== 'running')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const pick = terminal[0] ?? advisor.results[0];
    if (pick) setSelectedVariant(pick.variant);
  }, [advisor.results, selectedVariant]);

  // Switching slots discards the previous slot's selection.
  useEffect(() => setSelected(new Set()), [selectedVariant]);

  const promptMut = useMutation({
    mutationFn: () => fetchImproveConfigPrompt(profileId, runId),
  });
  const parseMut = useMutation({
    mutationFn: (r: string) => parseImproveConfigReply(profileId, runId, r),
    onSuccess: (row) => {
      advisor.seedRow(row);
      setSelectedVariant('manual');
      setManualOpen(false);
      setReply('');
    },
  });

  const isVariantBusy = (v: ImproveConfigMode): boolean =>
    advisor.byVariant.get(v)?.status === 'running' ||
    (advisor.start.isPending && advisor.start.variables === v);

  // Click a variant: show a saved `done` row instantly (no re-bill); otherwise
  // enqueue a background generation. A `running` slot just shows its spinner.
  const pickVariant = (v: ImproveConfigMode): void => {
    setSelectedVariant(v);
    const row = advisor.byVariant.get(v);
    if (row?.status === 'done' || isVariantBusy(v)) return;
    advisor.start.mutate(v);
  };

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openManual = (): void => {
    setSelectedVariant(null);
    setManualOpen(true);
    if (!promptMut.data && !promptMut.isPending) promptMut.mutate();
  };
  const copyPrompt = async (): Promise<void> => {
    if (!promptMut.data) return;
    // writeText rejects in an insecure context or when clipboard access is denied.
    // The prompt is also visible in the <pre> for manual selection, so on failure
    // leave the label as-is rather than throwing an unhandled rejection.
    try {
      await navigator.clipboard.writeText(promptMut.data.prompt);
      toast.success('Prompt copied to clipboard.');
    } catch {
      /* fall back to manual selection of the visible prompt */
    }
  };

  const row = selectedVariant ? advisor.byVariant.get(selectedVariant) : undefined;
  const running =
    selectedVariant !== null &&
    (row?.status === 'running' ||
      (advisor.start.isPending && advisor.start.variables === selectedVariant));
  const suggestions = row?.status === 'done' ? row.suggestions : [];
  const dropped = row?.status === 'done' ? row.dropped : [];
  const chosen = suggestions.filter((s) => selected.has(s.id));
  const load = (): void =>
    onApply(applyRecommendations(config, configSuggestionsToRecommendations(chosen)));

  // A 503 off the start mutation means the study worker has no credential.
  const unavailable = advisor.start.error instanceof ApiError && advisor.start.error.status === 503;
  const startErrored = advisor.start.isError && !unavailable;

  return (
    <section
      aria-labelledby="bt-llm-h"
      data-testid="backtest-llm-advisor"
      className="border-border bg-bg-elevated space-y-3 rounded-md border p-3"
    >
      <div className="space-y-1">
        <h2 id="bt-llm-h" className="text-fg flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles aria-hidden className="h-4 w-4" />
          Ask AI for config ideas
        </h2>
        <p className="text-xs">
          The AI reads this run — the metrics, what blocked entries, the per-regime split, and the
          out-of-sample holdout — and suggests config changes aimed at forward performance, not the
          in-sample number. Suggestions are saved to this run, so they survive a reload. Review
          each, load the ones you want into Setup, and run it yourself. Nothing touches your live
          config, and the out-of-sample gate still stands before going live.
        </p>
      </div>

      <p className="text-xs">
        Pick how the AI reads this run. <strong>Safe</strong> suggests only high-confidence changes
        and says HOLD when nothing beats holding. The others explore a bolder direction — hypotheses
        to test, still gated by the out-of-sample gate. A saved variant opens instantly.
      </p>
      <p
        role="note"
        className="border-warning/40 bg-bg-elevated rounded-md border px-2.5 py-1.5 text-xs"
      >
        Explore variants suggest higher-variance changes, including larger position sizing, which
        amplifies losses as well as gains. Treat every suggestion as a hypothesis to re-run, not a
        fix.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {VARIANTS.map((v) => {
          const busy = isVariantBusy(v);
          const saved = advisor.byVariant.get(v)?.status === 'done';
          const active = selectedVariant === v;
          return (
            <Button
              key={v}
              type="button"
              variant={active ? 'primary' : 'outline'}
              className="h-11 w-full"
              disabled={busy}
              onClick={() => pickVariant(v)}
              data-testid={`backtest-llm-ask-${v}`}
            >
              {busy ? (
                <>
                  <Loader2 aria-hidden className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  {saved ? <Check aria-hidden className="mr-1 h-3.5 w-3.5" /> : null}
                  {VARIANT_LABEL[v]}
                </>
              )}
            </Button>
          );
        })}
        <Button
          type="button"
          variant={selectedVariant === 'manual' || manualOpen ? 'primary' : 'outline'}
          className="h-11 w-full"
          disabled={promptMut.isPending}
          onClick={openManual}
          data-testid="backtest-llm-manual-open"
        >
          {promptMut.isPending ? 'Building prompt…' : 'Run it myself'}
        </Button>
      </div>

      {unavailable ? (
        <p className="text-down text-xs" data-testid="backtest-llm-error">
          {NOT_CONFIGURED_NOTE}
        </p>
      ) : startErrored ? (
        <p className="text-down text-xs" data-testid="backtest-llm-error">
          {errorMessage(advisor.start.error)}
        </p>
      ) : null}

      {manualOpen ? (
        <div className="border-border space-y-2 border-t pt-3" data-testid="backtest-llm-manual">
          <p className="text-muted-fg text-xs">
            Copy this prompt into your AI chat (e.g. <strong>claude.ai</strong>), then paste the
            reply below. Use this when you&rsquo;d rather not configure a server-side provider. The
            result is saved to this run like the others.
          </p>
          {promptMut.isError ? (
            <p className="text-down text-xs">{errorMessage(promptMut.error)}</p>
          ) : null}
          {promptMut.data ? (
            <>
              <div className="relative">
                <pre
                  data-testid="backtest-llm-prompt"
                  className="border-border bg-surface-alt max-h-48 overflow-auto whitespace-pre-wrap rounded-md border p-2 pr-16 text-[11px] leading-snug"
                >
                  {promptMut.data.prompt}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="absolute right-1.5 top-1.5"
                  onClick={copyPrompt}
                  data-testid="backtest-llm-copy"
                >
                  <Copy aria-hidden className="mr-1 h-3 w-3" />
                  Copy
                </Button>
              </div>
              <textarea
                aria-label="the AI's reply"
                data-testid="backtest-llm-reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Paste the AI's reply here"
                className="border-border bg-surface-alt focus-visible:ring-focus h-24 w-full rounded-md border p-2 text-xs focus-visible:outline-none focus-visible:ring-2"
              />
              {parseMut.isError ? (
                <p className="text-down text-xs" data-testid="backtest-llm-parse-error">
                  {errorMessage(parseMut.error)}
                </p>
              ) : null}
              <Button
                type="button"
                variant="primary"
                className="h-11 w-full"
                disabled={reply.trim() === '' || parseMut.isPending}
                onClick={() => parseMut.mutate(reply)}
                data-testid="backtest-llm-parse"
              >
                {parseMut.isPending ? 'Reading…' : "Load the AI's answer"}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {selectedVariant !== null && !manualOpen ? (
        <div className="border-border space-y-3 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-fg text-xs">
              Variant: <span className="text-fg font-medium">{SLOT_LABEL[selectedVariant]}</span>
            </span>
            {selectedVariant !== 'manual' ? (
              <Button
                type="button"
                variant="outline"
                className="h-8 px-2 text-xs"
                disabled={running}
                onClick={() => advisor.start.mutate(selectedVariant)}
                data-testid={`backtest-llm-regenerate-${selectedVariant}`}
              >
                <RefreshCw aria-hidden className="mr-1 h-3 w-3" />
                Regenerate
              </Button>
            ) : null}
          </div>

          {running ? (
            <div
              className="text-muted-fg flex items-center gap-2 text-xs"
              data-testid="backtest-llm-generating"
            >
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              Generating suggestions… this runs in the background, so you can leave and come back.
            </div>
          ) : row?.status === 'error' ? (
            <p className="text-down text-xs" data-testid="backtest-llm-error">
              {row.errorReason === 'not-configured'
                ? NOT_CONFIGURED_NOTE
                : 'The AI couldn’t generate suggestions for this run. Try Regenerate.'}
            </p>
          ) : row?.status === 'done' ? (
            <>
              <p className="text-muted-fg text-xs" data-testid="backtest-llm-summary">
                {row.summary}
              </p>
              {suggestions.length > 0 ? (
                <>
                  <ul className="space-y-2">
                    {suggestions.map((s) => {
                      const isSelected = selected.has(s.id);
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            aria-label={s.title}
                            onClick={() => toggle(s.id)}
                            data-testid={`backtest-llm-toggle-${s.id}`}
                            className={`focus-visible:ring-focus flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 ${
                              isSelected
                                ? 'border-accent bg-accent/10'
                                : 'border-border bg-surface-alt'
                            }`}
                          >
                            <span
                              aria-hidden
                              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                isSelected
                                  ? 'border-accent bg-accent text-accent-fg'
                                  : 'border-border'
                              }`}
                            >
                              {isSelected ? <Check className="h-3 w-3" /> : null}
                            </span>
                            <span className="space-y-1">
                              <span className="text-fg block text-sm font-medium">{s.title}</span>
                              <span className="text-muted-fg block text-xs leading-snug">
                                {s.rationale}
                              </span>
                              {s.expectedEffect ? (
                                <span className="text-muted-fg block text-xs leading-snug">
                                  Expected effect: {s.expectedEffect}
                                </span>
                              ) : null}
                              <span
                                className={`block text-xs font-medium ${RISK_TINT[s.overfitRisk]}`}
                              >
                                Overfit risk: {s.overfitRisk}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="border-border space-y-1.5 border-t pt-3">
                    <Button
                      type="button"
                      variant="primary"
                      className="h-11 w-full"
                      disabled={chosen.length === 0}
                      onClick={load}
                      data-testid="backtest-llm-load-selected"
                    >
                      {chosen.length === 0
                        ? 'Select changes to load'
                        : `Load ${chosen.length} change${chosen.length > 1 ? 's' : ''} into Setup`}
                    </Button>
                    <p className="text-muted-fg text-xs">
                      Loads into the Setup form for review. You run the backtest, and the new run
                      must clear the out-of-sample gate before you can apply it to live.
                    </p>
                  </div>
                </>
              ) : null}

              {dropped.length > 0 ? (
                <div
                  className="border-border space-y-2 border-t pt-3"
                  data-testid="backtest-llm-dropped"
                >
                  <p className="text-warning text-xs font-medium">
                    {dropped.length === 1
                      ? 'The AI proposed 1 change that doesn’t fit the strategy’s allowed settings, so it was skipped:'
                      : `The AI proposed ${dropped.length} changes that don’t fit the strategy’s allowed settings, so they were skipped:`}
                  </p>
                  <ul className="space-y-2">
                    {dropped.map((d) => (
                      <li
                        key={d.id}
                        data-testid={`backtest-llm-dropped-${d.id}`}
                        className="border-border bg-surface-alt rounded-md border border-dashed p-3"
                      >
                        <span className="text-muted-fg block text-sm font-medium">{d.title}</span>
                        <span className="text-muted-fg block font-mono text-xs leading-snug">
                          {d.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {suggestions.length === 0 && dropped.length === 0 ? (
                <p className="text-muted-fg text-xs">
                  No config change suggested — the AI didn&rsquo;t find one likely to beat what you
                  have.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
