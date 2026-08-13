// SymbolAdvancedDrawer — collapsed-by-default drawer of destructive,
// rarely-used per-symbol actions. Each action gates behind a confirm modal
// so the operator never one-clicks data loss; the wipe modal is the most
// dangerous so its modal lists exactly what will be cascaded.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { errorMessage } from '@/shared/lib/api';
import {
  archiveGridTrade,
  deleteAvgEntryPrice,
  resetGridTrade,
  resetSymbolConfig,
  setAvgEntryPrice,
  symbolStateQueryKey,
  wipeSymbol,
} from '@/features/symbol/api/symbol';

import { asDecimalString } from '@app/contracts';

type Action =
  null | 'archive-grid' | 'reset-grid' | 'reset-config' | 'set-lbp' | 'delete-lbp' | 'wipe';

interface AdvancedDrawerProps {
  readonly profileId: string;
  readonly symbol: string;
  /**
   * Whether to show the trailing-trade grid actions (archive/reset grid,
   * set/delete avg-entry-price). Set from the resolved StrategyView so a
   * non-grid strategy sees only the strategy-agnostic reset-config + wipe.
   */
  readonly showGridActions: boolean;
  /**
   * Called after `wipeSymbol` succeeds so the route can navigate away from
   * a now-deleted resource (the /state endpoint will 404 on next refetch
   * otherwise).
   */
  readonly onWiped?: () => void;
}

/**
 * Drawer of destructive per-symbol actions. The action list is intentionally
 * ordered least → most destructive: archive (closes & records), reset grid
 * (rebuilds ladder from current price), reset config (drop override), LBP
 * set/delete (operator's cost basis), full wipe (cascades the symbol row).
 */
export function SymbolAdvancedDrawer({
  profileId,
  symbol,
  showGridActions,
  onWiped,
}: AdvancedDrawerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [lbpInput, setLbpInput] = useState('');
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const queryClient = useQueryClient();

  const close = (): void => setAction(null);

  const invalidate = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: symbolStateQueryKey(profileId, symbol) });

  const archive = useMutation({
    mutationFn: () => archiveGridTrade(profileId, symbol),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Archive scheduled.' });
      close();
      await invalidate();
    },
    onError: (e) => setBanner({ kind: 'err', message: errorMessage(e) }),
  });
  const reset = useMutation({
    mutationFn: () => resetGridTrade(profileId, symbol),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Reset scheduled.' });
      close();
      await invalidate();
    },
    onError: (e) => setBanner({ kind: 'err', message: errorMessage(e) }),
  });
  const resetCfg = useMutation({
    mutationFn: () => resetSymbolConfig(profileId, symbol),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Per-symbol config cleared.' });
      close();
      await invalidate();
    },
    onError: (e) => setBanner({ kind: 'err', message: errorMessage(e) }),
  });
  const setLbp = useMutation({
    mutationFn: (raw: string) => setAvgEntryPrice(profileId, symbol, asDecimalString(raw)),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Average entry price updated.' });
      setLbpInput('');
      close();
      await invalidate();
    },
    onError: (e) => setBanner({ kind: 'err', message: errorMessage(e) }),
  });
  const deleteLbp = useMutation({
    mutationFn: () => deleteAvgEntryPrice(profileId, symbol),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Average entry price cleared.' });
      close();
      await invalidate();
    },
    onError: (e) => setBanner({ kind: 'err', message: errorMessage(e) }),
  });
  const wipe = useMutation({
    mutationFn: () => wipeSymbol(profileId, symbol),
    onSuccess: () => {
      setBanner({ kind: 'ok', message: 'Symbol wiped.' });
      close();
      onWiped?.();
    },
    onError: (e) => setBanner({ kind: 'err', message: errorMessage(e) }),
  });

  const onConfirm = (): void => {
    setBanner(null);
    if (action === 'archive-grid') archive.mutate();
    else if (action === 'reset-grid') reset.mutate();
    else if (action === 'reset-config') resetCfg.mutate();
    else if (action === 'delete-lbp') deleteLbp.mutate();
    else if (action === 'set-lbp') setLbp.mutate(lbpInput.trim());
    else if (action === 'wipe') wipe.mutate();
  };

  const pending =
    archive.isPending ||
    reset.isPending ||
    resetCfg.isPending ||
    setLbp.isPending ||
    deleteLbp.isPending ||
    wipe.isPending;

  return (
    <section className="space-y-2" data-testid="symbol-advanced-drawer">
      <button
        type="button"
        className="text-xs text-muted-fg underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        onClick={() => setOpen((o) => !o)}
        data-testid="advanced-toggle"
        aria-expanded={open}
      >
        {open ? 'Hide advanced' : 'Show advanced'}
      </button>

      {open ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="advanced-actions">
          {/* Grid actions are trailing-trade concepts; hidden for strategies
              without a grid. reset-config + wipe are strategy-agnostic. */}
          {showGridActions ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setAction('archive-grid')}
                data-testid="action-archive-grid"
              >
                Archive grid
              </Button>
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setAction('reset-grid')}
                data-testid="action-reset-grid"
              >
                Reset grid
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="default"
            onClick={() => setAction('reset-config')}
            data-testid="action-reset-config"
          >
            Reset config
          </Button>
          {showGridActions ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setAction('set-lbp')}
                data-testid="action-set-lbp"
              >
                Set average entry price
              </Button>
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setAction('delete-lbp')}
                data-testid="action-delete-lbp"
              >
                Delete average entry price
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            size="default"
            onClick={() => setAction('wipe')}
            data-testid="action-wipe"
          >
            Wipe symbol
          </Button>
        </div>
      ) : null}

      <ActionBanner banner={banner} />

      <Dialog open={action !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{titleFor(action, symbol)}</DialogTitle>
            <DialogDescription>{descriptionFor(action, symbol)}</DialogDescription>
          </DialogHeader>

          {action === 'wipe' ? (
            <Alert variant="danger">
              <AlertTitle>⚠ Open orders are not cancelled</AlertTitle>
              <AlertDescription>
                Wiping {symbol} does not touch any live Binance orders. Cancel them on Binance first
                if you need them gone.
              </AlertDescription>
            </Alert>
          ) : null}

          {action === 'set-lbp' ? (
            <Label className="flex flex-col gap-1 text-xs">
              <span>New avg-entry-price</span>
              <Input
                inputMode="decimal"
                value={lbpInput}
                onChange={(e) => setLbpInput(e.target.value)}
                placeholder="Enter a price to confirm"
                data-testid="advanced-lbp-input"
              />
            </Label>
          ) : null}

          <FormActions>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="advanced-confirm"
              disabled={pending || (action === 'set-lbp' && !lbpInput.trim())}
              onClick={onConfirm}
            >
              {pending ? 'Working…' : 'Confirm'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const titleFor = (action: Action, symbol: string): string => {
  switch (action) {
    case 'archive-grid':
      return `Archive grid trade for ${symbol}?`;
    case 'reset-grid':
      return `Reset grid trade for ${symbol}?`;
    case 'reset-config':
      return `Reset per-symbol config for ${symbol}?`;
    case 'set-lbp':
      return `Set avg-entry-price for ${symbol}?`;
    case 'delete-lbp':
      return `Delete avg-entry-price for ${symbol}?`;
    case 'wipe':
      return `Wipe ${symbol}?`;
    default:
      return '';
  }
};

const descriptionFor = (action: Action, symbol: string): string => {
  switch (action) {
    case 'archive-grid':
      return `Closes the open grid, records realised P/L into the archive, and sends a notification. ${symbol} stays configured for new ladders.`;
    case 'reset-grid':
      return `Clears the grid row so the strategy rebuilds the ladder from current price on the next tick. Open orders are not cancelled — cancel them first if needed.`;
    case 'reset-config':
      return `Drops the per-symbol config override; ${symbol} falls back to the profile-level config on the next tick.`;
    case 'set-lbp':
      return `Updates the operator's cost basis. The worker reads the on-balance quantity from the user-stream snapshot at apply time.`;
    case 'delete-lbp':
      return `Clears the avg-entry-price so the strategy stops sizing sells against it.`;
    case 'wipe':
      return `Removes ${symbol} from the profile entirely: its per-symbol configuration, the recorded average entry price, any pending override actions, and the cached open-orders list. The trade history is kept for audit. Live Binance orders are NOT cancelled — cancel them first if needed. The strategy stops touching ${symbol}. This is irreversible.`;
    default:
      return '';
  }
};
