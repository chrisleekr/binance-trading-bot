// Apply a finished run's tested config to the profile's live config.
//
// A backtest runs the profile config deep-merged with the run's
// strategyConfigOverride; for a backtest launched from this UI the override is
// the full edited config. "Apply to live config" PATCHes that config onto the
// profile (the same write path as the Config page), so a trader who likes a
// result can adopt it without re-keying every field. The confirm dialog lists
// exactly which fields change, computed against the current live config — so a
// stale result that matches the live config shows nothing to apply.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { errorMessage } from '@/shared/lib/api';
import { diffConfig, overrideLeaves } from '@/shared/lib/config-diff';
import { notifySaveDiagnostics } from '@/shared/lib/save-diagnostics';
import { fetchProfile, patchProfile, profileQueryKey } from '@/features/profile/api/profile';

import { titleCase } from '@app/contracts';

export interface BacktestApplyConfigProps {
  readonly profileId: string;
  /** The full strategy config the finished run was executed with. */
  readonly testedConfig: Record<string, unknown>;
  /**
   * Honest caveat shown next to the apply control and inside the confirm dialog
   * when this run has no measured edge (lost to hold) or is below the live-gate
   * bar. Applying still works — apply writes the config, it does not enable the
   * profile — but the operator should know the config stays unproven against the
   * advisory gate (and, if pause-buys is on, would keep new buys paused).
   */
  readonly warning?: string | null;
}

/** A leaf value rendered in the change summary. Arrays/objects are shown as JSON. */
function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Turn a dot-path into a readable label: `buy.maxPurchaseAmount` → `Buy › Max Purchase Amount`. */
function labelForPath(path: string): string {
  return path
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? `#${Number(seg) + 1}` : titleCase(seg)))
    .join(' › ');
}

export function BacktestApplyConfig({
  profileId,
  testedConfig,
  warning,
}: BacktestApplyConfigProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const queryKey = profileQueryKey(profileId);
  const [open, setOpen] = useState(false);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const profile = useQuery({ queryKey, queryFn: () => fetchProfile(profileId) });

  const apply = useMutation({
    mutationFn: () => {
      const live = (profile.data?.config ?? {}) as Record<string, unknown>;
      return patchProfile(profileId, { config: { ...testedConfig, symbol: live['symbol'] } });
    },
    onSuccess: async (saved) => {
      setOpen(false);
      setBanner({ kind: 'ok', message: 'Applied to live config.' });
      notifySaveDiagnostics(saved.diagnostics);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  const liveConfig = profile.data?.config as Record<string, unknown> | undefined;
  // Wait for the live config before diffing — a premature diff against
  // undefined would falsely report every field as changed.
  if (liveConfig === undefined) return null;

  // Apply the tuned config but keep the profile's own symbol: the backtest's
  // symbol selects the market under test, not a retarget of which pair the live
  // profile trades. Changing the traded pair stays a deliberate Config edit.
  const applyConfig = { ...testedConfig, symbol: liveConfig['symbol'] };
  const diff = diffConfig(liveConfig, applyConfig);
  const leaves = overrideLeaves(liveConfig, diff);

  return (
    <div className="space-y-2">
      <ActionBanner banner={banner} />
      {leaves.length === 0 ? (
        <p className="text-sm text-muted-fg">
          This run's config matches the live config — nothing to apply.
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-fg">
            This run tested {leaves.length} field{leaves.length === 1 ? '' : 's'} that differ from
            the live config.
          </p>
          <Button type="button" className="h-11 w-full" onClick={() => setOpen(true)}>
            Apply to live config
          </Button>
          {warning ? <p className="text-xs text-warning">{warning}</p> : null}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply tested config?</DialogTitle>
            <DialogDescription>
              These fields will overwrite the profile's live config. An enabled profile picks up the
              change on its next reconfigure.
            </DialogDescription>
          </DialogHeader>
          {warning ? (
            <p className="rounded-md bg-bg-elevated p-2 text-xs text-warning">{warning}</p>
          ) : null}
          <ul className="max-h-64 divide-y divide-border overflow-y-auto text-sm">
            {leaves.map((leaf) => (
              <li key={leaf.path} className="flex flex-col gap-0.5 py-2">
                <span className="font-medium">{labelForPath(leaf.path)}</span>
                <span className="text-muted-fg tabular-nums">
                  {formatValue(leaf.inherited)} →{' '}
                  <span className="text-fg">{formatValue(leaf.override)}</span>
                </span>
              </li>
            ))}
          </ul>
          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={apply.isPending} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Applying…' : 'Confirm'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
