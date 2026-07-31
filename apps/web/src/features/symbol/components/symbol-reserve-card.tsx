// Per-symbol "always hold" reserve control.
//
// Sets the base-asset quantity the bot must never sell below ("hold 50 ADA, keep
// trading on top"). The bot trades only the surplus above this floor and never
// sells into it. Leaving the field blank and saving removes the reserve. The
// server rejects a reserve larger than the live holding; that message surfaces in
// the banner.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { putSymbolReserve, symbolOverrideQueryKey } from '@/features/symbol/api/symbol';
import { errorMessage } from '@/shared/lib/api';

export function SymbolReserveCard({
  profileId,
  symbol,
  reserve,
}: {
  readonly profileId: string;
  readonly symbol: string;
  readonly reserve: string | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(reserve ?? '');
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const mutation = useMutation({
    mutationFn: (next: string | null) => putSymbolReserve(profileId, symbol, next),
    onSuccess: async (_result, next) => {
      setBanner({
        kind: 'ok',
        message:
          next === null
            ? 'Reserve cleared — the bot can trade the full balance.'
            : `Always holding ${next}. The bot trades only what's above this.`,
      });
      await queryClient.invalidateQueries({ queryKey: symbolOverrideQueryKey(profileId, symbol) });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  const trimmed = value.trim();
  // Dirty against the persisted value so Save is inert until the operator changes
  // something (and an empty box equals "no reserve").
  const dirty = trimmed !== (reserve ?? '');

  return (
    <Card>
      <section className="space-y-4" data-testid="symbol-reserve-card">
        <div className="space-y-1">
          <h2 className="text-fg text-sm font-semibold">Always hold</h2>
          <p className="text-muted-fg text-sm">
            Keep a fixed amount of this coin the bot never sells. It trades only what you hold above
            this floor and never sells into it. Set at most what you already hold; leave blank and
            save to remove it.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="symbol-reserve-input">Amount to always hold (base-coin units)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="symbol-reserve-input"
              data-testid="symbol-reserve-input"
              inputMode="decimal"
              placeholder="e.g. 50"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button
              type="button"
              data-testid="symbol-reserve-save"
              disabled={mutation.isPending || !dirty}
              onClick={() => mutation.mutate(trimmed === '' ? null : trimmed)}
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        <ActionBanner banner={banner} />
      </section>
    </Card>
  );
}
