// Profile General settings — the per-profile identity, execution mode, lifecycle
// (enable/disable + per-profile stop), API key, and the destructive delete, all
// on one page (/profiles/:id/general) reached from the Manage menu. These were
// the lifecycle/admin tiles that used to live in the Manage slide-over; they
// moved here so the menu is pure navigation and every profile-level setting has
// one home. Name and quote edit inline; the consequential actions (enable/disable,
// stop, delete) each open a confirm dialog so a stray click never
// executes. A delete refused for live exposure escalates the same dialog to a
// DISPOSAL step (it needs the open-order counts and a second button that asks the
// worker to cancel those orders on Binance first), so it stays inline; every other
// action result goes to a toast.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';

import { ProfileName, QuoteAsset, type DashboardAggregateResponse } from '@app/contracts';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import {
  disableKillSwitch,
  enableKillSwitch,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import {
  deleteProfile,
  patchProfile,
  startProfile,
  stopProfile,
} from '@/features/profile/api/profiles-mutations';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { Button } from '@/shared/components/ui/button';
import { FormActions } from '@/shared/components/form-actions';
import { Panel } from '@/shared/components/panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { ApiError } from '@/shared/lib/api';
import { t } from '@/shared/lib/i18n';

type ProfileRow = DashboardAggregateResponse['profiles'][number];

export function ProfileGeneralPanel({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const accountId = useActiveAccountId() ?? '';
  const aggregate = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const row = aggregate.data?.profiles.find((p) => p.profileId === profileId);
  // Mirror the gate panel: a brief Loading line while the aggregate resolves,
  // then nothing if the profile is genuinely absent.
  if (!row) {
    return aggregate.isLoading ? <p className="text-muted-fg text-sm">Loading…</p> : null;
  }
  // The account's other profiles are the candidate handoff targets when this
  // profile is deleted with live exposure. Derived from the same aggregate the
  // panel already reads so there is one data source, not a second query.
  const siblings = (aggregate.data?.profiles ?? [])
    .filter((p) => p.profileId !== profileId)
    .map((p) => ({ id: p.profileId, name: p.name }));
  return <GeneralPanelBody key={profileId} profileId={profileId} row={row} siblings={siblings} />;
}

// Split so the body mounts only once the aggregate row exists — the inline name
// and quote drafts then seed from the row via useState lazy-init, no effect.
function GeneralPanelBody({
  profileId,
  row,
  siblings,
}: {
  readonly profileId: string;
  readonly row: ProfileRow;
  readonly siblings: readonly { readonly id: string; readonly name: string }[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const routeNavigate = useNavigate();
  const accountId = useActiveAccountId() ?? '';

  const [draftName, setDraftName] = useState(row.name);
  const [draftQuote, setDraftQuote] = useState(row.quoteAsset);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Non-null once the server refuses the delete for live exposure (409 CONFLICT):
  // the same dialog then shows what is still open, plus the button that disposes of
  // it (cancel the orders on Binance, then delete).
  const [deleteExposure, setDeleteExposure] = useState<{
    openOrderCount: number;
    openPositionCount: number;
  } | null>(null);
  // Which disposition the operator picked for a profile with live exposure.
  // Defaults to cancel-orders; handoff is offered only when the account has
  // another profile to receive the position (`handoffTargets`).
  const [disposition, setDisposition] = useState<'cancel-orders' | 'handoff'>('cancel-orders');
  const [handoffTargetId, setHandoffTargetId] = useState('');
  const handoffTargets = siblings;

  const invalidateProfile = (): Promise<unknown> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dashboard-aggregate', accountId] }),
      queryClient.invalidateQueries({ queryKey: profileDashboardQueryKey(profileId) }),
    ]);

  const enableToggle = useMutation({
    mutationFn: (next: boolean) => (next ? startProfile(profileId) : stopProfile(profileId)),
    onSuccess: async () => {
      setConfirmEnable(false);
      await invalidateProfile();
    },
    onError: (err: unknown) => {
      // Close the dialog so the toast is visible. The 409 edge-gate rejection
      // carries its full "why" in err.message (e.g. profit factor below the bar).
      setConfirmEnable(false);
      toast.error(err instanceof Error ? err.message : t('profile.controls.enable_failed'));
    },
  });

  const killToggle = useMutation({
    mutationFn: (engage: boolean) =>
      engage ? enableKillSwitch(profileId) : disableKillSwitch(profileId),
    onSuccess: async () => {
      setConfirmKill(false);
      await invalidateProfile();
    },
    onError: (err: unknown) => {
      setConfirmKill(false);
      toast.error(err instanceof Error ? err.message : t('profile.controls.kill_failed'));
    },
  });

  const rename = useMutation({
    mutationFn: (name: string) => patchProfile(profileId, { name }),
    onSuccess: async () => {
      await invalidateProfile();
      toast.success(t('profile.controls.saved'));
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : t('profile.controls.rename_failed')),
  });

  const setQuote = useMutation({
    mutationFn: (quoteAsset: string) => patchProfile(profileId, { quoteAsset }),
    onSuccess: async () => {
      await invalidateProfile();
      toast.success(t('profile.controls.saved'));
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : t('profile.controls.quote_failed')),
  });

  const closeDelete = (): void => {
    setConfirmDelete(false);
    setDeleteExposure(null);
    setDisposition('cancel-orders');
    setHandoffTargetId('');
  };
  const del = useMutation({
    // A handoff carries the target profile; cancel-orders (and the no-exposure
    // delete) carry no third argument, so the call shape stays stable for both.
    mutationFn: (v: { disposition?: 'cancel-orders' | 'handoff'; toProfileId?: string } = {}) =>
      v.toProfileId !== undefined
        ? deleteProfile(profileId, v.disposition, v.toProfileId)
        : deleteProfile(profileId, v.disposition),
    onSuccess: async () => {
      closeDelete();
      await invalidateProfile();
      // The profile is gone — route to the account root so the UI does not sit
      // on a now-deleted profile.
      void routeNavigate({ to: '/accounts/$accountId', params: { accountId } });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        const d = err.details as
          | { openOrderCount?: number; openPositionCount?: number }
          | undefined;
        setDeleteExposure({
          openOrderCount: d?.openOrderCount ?? 0,
          openPositionCount: d?.openPositionCount ?? 0,
        });
        return;
      }
      closeDelete();
      toast.error(err instanceof Error ? err.message : t('profile.controls.delete_failed'));
    },
  });

  // Validate drafts against the shared contracts so the page rejects the same
  // values the server would; quote is uppercased to match the exchange suffixes.
  const renameParsed = ProfileName.safeParse(draftName);
  const renameError =
    draftName.trim() !== '' && !renameParsed.success
      ? (renameParsed.error.issues[0]?.message ?? 'Invalid name')
      : null;
  const quoteUpper = draftQuote.trim().toUpperCase();
  const quoteParsed = QuoteAsset.safeParse(quoteUpper);
  const quoteError =
    draftQuote.trim() !== '' && !quoteParsed.success
      ? (quoteParsed.error.issues[0]?.message ?? 'Invalid quote currency')
      : null;

  const killOn = row.killSwitch;

  return (
    <div className="space-y-6" data-testid="profile-general-panel">
      <Panel title="Name">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="profile-general-name-input" className="sr-only">
              {t('profile.controls.rename')}
            </Label>
            <Input
              id="profile-general-name-input"
              value={draftName}
              data-testid="profile-general-name-input"
              onChange={(e) => setDraftName(e.target.value)}
            />
            {renameError ? <p className="text-danger text-xs">{renameError}</p> : null}
          </div>
          <Button
            data-testid="profile-general-name-save"
            disabled={!renameParsed.success || draftName === row.name || rename.isPending}
            onClick={() => renameParsed.success && rename.mutate(renameParsed.data)}
          >
            {rename.isPending ? t('profile.controls.working') : t('profile.controls.save')}
          </Button>
        </div>
      </Panel>

      <Panel
        title={t('profile.controls.quote')}
        description="The currency this profile prices and settles trades in, e.g. USDT."
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="profile-general-quote-input" className="sr-only">
              {t('profile.controls.quote')}
            </Label>
            <Input
              id="profile-general-quote-input"
              value={draftQuote}
              data-testid="profile-general-quote-input"
              autoCapitalize="characters"
              onChange={(e) => setDraftQuote(e.target.value)}
            />
            {quoteError ? <p className="text-danger text-xs">{quoteError}</p> : null}
          </div>
          <Button
            data-testid="profile-general-quote-save"
            disabled={!quoteParsed.success || quoteUpper === row.quoteAsset || setQuote.isPending}
            onClick={() => quoteParsed.success && setQuote.mutate(quoteParsed.data)}
          >
            {setQuote.isPending ? t('profile.controls.working') : t('profile.controls.save')}
          </Button>
        </div>
      </Panel>

      <Panel
        title="Status"
        description="Enable starts the bot trading this profile; the per-profile stop halts new buys while letting open positions exit."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="profile-general-enable"
            variant={row.enabled ? 'outline' : 'default'}
            onClick={() => setConfirmEnable(true)}
          >
            {row.enabled ? t('profile.controls.disable') : t('profile.controls.enable')}
          </Button>
          <Button
            data-testid="profile-general-kill"
            variant={killOn ? 'default' : 'destructive'}
            onClick={() => setConfirmKill(true)}
          >
            {killOn ? t('profile.controls.kill_release') : t('profile.controls.kill_engage')}
          </Button>
        </div>
      </Panel>

      <Panel
        className="border-danger"
        title={<span className="text-danger">Danger zone</span>}
        description="Deleting a profile removes its config, history, and orders. This cannot be undone."
      >
        <Button
          variant="destructive"
          data-testid="profile-general-delete"
          onClick={() => setConfirmDelete(true)}
        >
          {t('profile.controls.delete')}
        </Button>
      </Panel>

      <Dialog open={confirmEnable} onOpenChange={setConfirmEnable}>
        <DialogContent data-testid="profile-general-enable-dialog">
          <DialogHeader>
            <DialogTitle>
              {row.enabled
                ? t('profile.controls.disable_title')
                : t('profile.controls.enable_title')}
            </DialogTitle>
            <DialogDescription>
              {row.enabled ? t('profile.controls.disable_body') : t('profile.controls.enable_body')}
            </DialogDescription>
          </DialogHeader>
          <FormActions className="mt-4">
            <Button variant="outline" onClick={() => setConfirmEnable(false)}>
              {t('profile.controls.cancel')}
            </Button>
            <Button
              variant={row.enabled ? 'outline' : 'default'}
              onClick={() => enableToggle.mutate(!row.enabled)}
              disabled={enableToggle.isPending}
              data-testid="profile-general-enable-confirm"
            >
              {enableToggle.isPending
                ? t('profile.controls.working')
                : row.enabled
                  ? t('profile.controls.disable')
                  : t('profile.controls.enable')}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmKill} onOpenChange={setConfirmKill}>
        <DialogContent data-testid="profile-general-kill-dialog">
          <DialogHeader>
            <DialogTitle>
              {killOn
                ? t('profile.controls.kill_release_title')
                : t('profile.controls.kill_engage_title')}
            </DialogTitle>
            <DialogDescription>
              {killOn
                ? t('profile.controls.kill_release_body')
                : t('profile.controls.kill_engage_body')}
            </DialogDescription>
          </DialogHeader>
          <FormActions className="mt-4">
            <Button variant="outline" onClick={() => setConfirmKill(false)}>
              {t('profile.controls.cancel')}
            </Button>
            <Button
              variant={killOn ? 'default' : 'destructive'}
              onClick={() => killToggle.mutate(!killOn)}
              disabled={killToggle.isPending}
              data-testid="profile-general-kill-confirm"
            >
              {killToggle.isPending
                ? t('profile.controls.working')
                : killOn
                  ? t('profile.controls.kill_release')
                  : t('profile.controls.kill_engage')}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={(o) => !o && closeDelete()}>
        <DialogContent data-testid="profile-general-delete-dialog">
          <DialogHeader>
            <DialogTitle>
              {deleteExposure
                ? t('profile.controls.delete_exposure_title')
                : t('profile.controls.delete_title')}
            </DialogTitle>
            <DialogDescription>
              {deleteExposure
                ? t('profile.controls.delete_exposure_body', {
                    orders: deleteExposure.openOrderCount,
                    positions: deleteExposure.openPositionCount,
                  })
                : t('profile.controls.delete_body', { name: row.name })}
            </DialogDescription>
          </DialogHeader>
          {deleteExposure ? (
            <div className="mt-4 flex flex-col gap-3">
              {handoffTargets.length > 0 && (
                // Two mutually exclusive dispositions, so a radio (not two
                // destructive buttons): the operator makes one explicit choice
                // and there is a single destructive action to press. Handoff is
                // only offered when the account has another profile to hand to.
                <fieldset className="flex flex-col gap-2 text-sm">
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="delete-disposition"
                      className="mt-1"
                      checked={disposition === 'cancel-orders'}
                      onChange={() => setDisposition('cancel-orders')}
                      data-testid="profile-general-delete-disposition-cancel"
                    />
                    <span>{t('profile.controls.delete_disposition_cancel')}</span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="delete-disposition"
                      className="mt-1"
                      checked={disposition === 'handoff'}
                      onChange={() => setDisposition('handoff')}
                      data-testid="profile-general-delete-disposition-handoff"
                    />
                    <span>{t('profile.controls.delete_disposition_handoff')}</span>
                  </label>
                  {disposition === 'handoff' && (
                    <select
                      value={handoffTargetId}
                      onChange={(e) => setHandoffTargetId(e.target.value)}
                      data-testid="profile-general-delete-handoff-target"
                      aria-label={t('profile.controls.delete_handoff_label')}
                      className="border-border bg-background ml-6 rounded-md border px-2 py-1"
                    >
                      <option value="">{t('profile.controls.delete_handoff_placeholder')}</option>
                      {handoffTargets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </fieldset>
              )}
              <FormActions>
                <Button variant="outline" onClick={closeDelete} disabled={del.isPending}>
                  {t('profile.controls.delete_cancel')}
                </Button>
                {/* No force-delete: abandoning the resting orders on Binance left
                    them holding the operator's coins. The worker either cancels
                    them or hands the position to the chosen profile, then deletes
                    once Binance is provably clear. */}
                <Button
                  variant="destructive"
                  onClick={() =>
                    del.mutate(
                      disposition === 'handoff'
                        ? { disposition: 'handoff', toProfileId: handoffTargetId }
                        : { disposition: 'cancel-orders' },
                    )
                  }
                  disabled={del.isPending || (disposition === 'handoff' && handoffTargetId === '')}
                  data-testid="profile-general-delete-dispose"
                >
                  {del.isPending
                    ? t('profile.controls.working')
                    : disposition === 'handoff'
                      ? t('profile.controls.delete_handoff_confirm')
                      : t('profile.controls.delete_dispose')}
                </Button>
              </FormActions>
            </div>
          ) : (
            <FormActions className="mt-4">
              <Button variant="outline" onClick={closeDelete} disabled={del.isPending}>
                {t('profile.controls.delete_cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => del.mutate({})}
                disabled={del.isPending}
                data-testid="profile-general-delete-confirm"
              >
                {del.isPending
                  ? t('profile.controls.working')
                  : t('profile.controls.delete_confirm')}
              </Button>
            </FormActions>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
