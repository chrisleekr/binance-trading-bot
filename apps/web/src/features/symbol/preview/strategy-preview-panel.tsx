// Generic strategy preview — renders any strategy's PreviewModel (from its
// lazy `./preview` module) as titled panels of level rows, with no
// strategy-specific code. Two entry points:
//   - PreviewModelView: the pure renderer (a model in, panels out) — testable
//     with a hand-built model.
//   - StrategyPreviewPanel: the config-page aside; reads the form's unsaved
//     draft via useWatch and resolves the model through usePreviewModel.
// apps/web is decimal-barred, so every money field arrives pre-computed as a
// string and this file only FORMATS (Number for display, no math on money).

import { useFormContext, useWatch } from 'react-hook-form';

import type {
  AccountSnapshotWire,
  PreviewModel,
  PreviewRow,
  SymbolFilters,
} from '@app/strategy-core';

import { Panel } from '@/shared/components/panel';
import { formatAmount, formatPercent, formatPrice } from '@/shared/lib/format';

import { humanizeCode } from './preview-chart-lines';
import { PREVIEW_TONE_TOKEN } from './tone';
import { usePreviewModel } from './use-preview-model';

/** Signed percent a level sits from the reference price, or null when either is missing. */
const offsetPct = (price: string | undefined, reference: string | null): string | null => {
  if (price == null || reference == null) return null;
  const p = Number(price);
  const r = Number(reference);
  if (!Number.isFinite(p) || !Number.isFinite(r) || r === 0) return null;
  return formatPercent((p / r - 1) * 100, { sign: true });
};

/** Which optional columns any row in a section populates, so the table stays narrow. */
interface SectionColumns {
  readonly symbol: boolean;
  readonly price: boolean;
  readonly qty: boolean;
  readonly weight: boolean;
  readonly drift: boolean;
}

const columnsFor = (rows: readonly PreviewRow[]): SectionColumns => ({
  symbol: rows.some((r) => r.symbol != null),
  price: rows.some((r) => r.price != null),
  qty: rows.some((r) => r.quantity != null),
  weight: rows.some((r) => r.weight != null),
  drift: rows.some((r) => r.drift != null),
});

function RowNote({ row }: { readonly row: PreviewRow }): React.JSX.Element | null {
  if (row.skip == null && row.note == null) return null;
  return (
    <div className="text-muted-fg mt-0.5 text-xs">
      {row.skip != null ? (
        <span className="text-warning" data-testid="preview-row-skip">
          Skipped — {row.skip}
        </span>
      ) : (
        row.note
      )}
    </div>
  );
}

function PreviewSection({
  title,
  rows,
  currentPrice,
}: {
  readonly title: string;
  readonly rows: readonly PreviewRow[];
  readonly currentPrice: string | null;
}): React.JSX.Element {
  const cols = columnsFor(rows);
  return (
    <Panel title={title} testId="strategy-preview-section">
      {/* Wide content scrolls inside its own container so the page body never
          scrolls horizontally on a 375px viewport. */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <tbody className="divide-border divide-y">
            {rows.map((row, i) => {
              const pct = offsetPct(row.price, currentPrice);
              return (
                <tr key={i} className="align-baseline" data-testid="preview-row">
                  <td className="py-1.5 pr-3">
                    <span className={PREVIEW_TONE_TOKEN[row.tone]}>
                      {row.label ?? humanizeCode(row.code)}
                    </span>
                    {row.trigger ? (
                      <span className="text-accent ml-1.5 text-[0.65rem] uppercase tracking-wide">
                        now
                      </span>
                    ) : null}
                    <RowNote row={row} />
                  </td>
                  {cols.symbol ? (
                    <td className="py-1.5 pr-3 font-medium">{row.symbol ?? '—'}</td>
                  ) : null}
                  {cols.price ? (
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono">
                      {row.price != null ? formatPrice(row.price) : '—'}
                      {pct != null ? <span className="text-muted-fg ml-1.5">{pct}</span> : null}
                    </td>
                  ) : null}
                  {cols.qty ? (
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono">
                      {row.quantity != null ? formatAmount(row.quantity) : '—'}
                    </td>
                  ) : null}
                  {cols.weight ? (
                    <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono">
                      {row.weight != null ? formatPercent(Number(row.weight) * 100) : '—'}
                    </td>
                  ) : null}
                  {cols.drift ? (
                    <td className="text-muted-fg whitespace-nowrap py-1.5 text-right font-mono">
                      {row.drift != null ? `±${formatPercent(Number(row.drift) * 100)}` : '—'}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/**
 * Pure renderer of a {@link PreviewModel}. `currentPrice` drives the per-row
 * percent offset only. Renders the empty state when the model has no sections.
 */
export function PreviewModelView({
  model,
  currentPrice,
  isLoading = false,
  error,
}: {
  readonly model: PreviewModel;
  readonly currentPrice: string | null;
  readonly isLoading?: boolean;
  readonly error?: unknown;
}): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="strategy-preview-panel">
      <div>
        <h2 className="text-fg text-sm font-semibold">Preview</h2>
        <p className="text-muted-fg text-xs">
          Live projection from your unsaved edits. Display only — the bot re-derives every level at
          decision time.
        </p>
      </div>

      {error != null ? (
        <p className="text-danger text-xs" data-testid="strategy-preview-error">
          Couldn't load the preview.
        </p>
      ) : model.sections.length > 0 ? (
        model.sections.map((section) => (
          <PreviewSection
            key={section.title}
            title={section.title}
            rows={section.rows}
            currentPrice={currentPrice}
          />
        ))
      ) : isLoading ? (
        <p className="text-muted-fg text-xs">Loading preview…</p>
      ) : (
        <p className="text-muted-fg text-xs" data-testid="strategy-preview-empty">
          Nothing to project yet — set the config and a reference price to see where this strategy
          would act.
        </p>
      )}
    </div>
  );
}

export interface StrategyPreviewPanelProps {
  readonly strategyName: string;
  readonly profileId: string;
  readonly symbol?: string | undefined;
  readonly currentPrice: string | null;
  readonly account?: AccountSnapshotWire | undefined;
  readonly quoteAsset?: string | undefined;
  readonly filters?: SymbolFilters | undefined;
}

/**
 * Config-page preview aside. Renders inside the AutoForm's FormProvider so it can
 * watch the live, unsaved config draft. State is `null` (config editing is a
 * flat/planning projection); the reference entry is the live price.
 */
export function StrategyPreviewPanel({
  strategyName,
  profileId,
  symbol,
  currentPrice,
  account,
  quoteAsset,
  filters,
}: StrategyPreviewPanelProps): React.JSX.Element {
  const { control } = useFormContext();
  const config = (useWatch({ control }) ?? {}) as Record<string, unknown>;
  const { model, isLoading, error } = usePreviewModel({
    strategyName,
    profileId,
    symbol,
    config,
    state: null,
    entryPrice: currentPrice,
    currentPrice,
    account,
    quoteAsset,
    filters,
  });
  return (
    <PreviewModelView
      model={model}
      currentPrice={currentPrice}
      isLoading={isLoading}
      error={error}
    />
  );
}
