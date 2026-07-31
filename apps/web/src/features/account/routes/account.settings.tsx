// `/accounts/$accountId/settings` — everything that acts on ONE Binance account:
// its display name, the environment its key pair talks to, the shortcuts into
// its wallet and order book, the stop-all-trading switch for its profiles, and
// the delete.
//
// The environment is read-only by design. It is a property of the API key pair
// the account holds; flipping it in place would point live keys at testnet (or
// worse, testnet keys at live) with no way to re-verify. To change environment,
// make another account.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { accountScopeRoute } from '@/features/account/routes/account-scope';
import {
  accountsQueryKey,
  deleteAccount,
  fetchAccount,
  patchAccount,
} from '@/features/account/api/accounts';
import { AccountKillSwitch } from '@/features/profile/components/account-kill-switch';
import { FormActions } from '@/shared/components/form-actions';
import { NavCard } from '@/shared/components/nav-card';
import { Page, PageHeader } from '@/shared/components/page';
import { Panel } from '@/shared/components/panel';
import { Badge } from '@/shared/components/ui/badge';
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
import { ApiError, errorMessage } from '@/shared/lib/api';

/** Exposure counts the API returns on a 409, so the dialog can name what is open. */
interface OpenExposure {
  readonly openOrderCount: number;
  readonly openPositionCount: number;
}

/** The 409 envelope's `details`, or null when the failure was something else. */
const exposureOf = (err: unknown): OpenExposure | null => {
  if (!(err instanceof ApiError) || err.code !== 'CONFLICT') return null;
  const details = err.details as Partial<OpenExposure> | undefined;
  return {
    openOrderCount: details?.openOrderCount ?? 0,
    openPositionCount: details?.openPositionCount ?? 0,
  };
};

function AccountSettingsPage(): React.JSX.Element {
  const { accountId } = accountSettingsRoute.useParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const account = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => fetchAccount(accountId),
  });

  const [name, setName] = useState('');
  // Seed from the server once it lands, and re-seed if the operator switches
  // account without unmounting the page.
  useEffect(() => {
    if (account.data) setName(account.data.name);
  }, [account.data]);

  const rename = useMutation({
    mutationFn: (next: string) => patchAccount(accountId, { name: next }),
    onSuccess: async () => {
      // The switcher reads the accounts list; without this it keeps showing the
      // old name until a reload.
      await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
      await queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      toast.success('Account renamed.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Set when the delete is refused because money is still committed. There is no
  // force path any more: the dialog explains what to do instead.
  const [blocked, setBlocked] = useState<OpenExposure | null>(null);

  const remove = useMutation({
    mutationFn: () => deleteAccount(accountId),
    onSuccess: async () => {
      setBlocked(null);
      await queryClient.invalidateQueries({ queryKey: accountsQueryKey });
      toast.success('Account deleted.');
      await router.navigate({ to: '/' });
    },
    onError: (err) => {
      const exposure = exposureOf(err);
      if (exposure) {
        setBlocked(exposure);
        return;
      }
      toast.error(errorMessage(err));
    },
  });

  const isTestnet = account.data?.binanceMode === 'test';

  return (
    <Page>
      <PageHeader title="Account settings" meta={account.data?.name} />

      <Panel title="Name" description="What this account is called across the app.">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const next = name.trim();
            if (next.length > 0) rename.mutate(next);
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="account-name">Account name</Label>
            <Input
              id="account-name"
              data-testid="account-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={rename.isPending} className="w-full sm:w-32">
            {rename.isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </Panel>

      <Panel title="Binance environment">
        <div className="space-y-2" data-testid="account-binance-mode">
          <Badge variant={isTestnet ? 'outline' : 'danger'}>{isTestnet ? 'Testnet' : 'Live'}</Badge>
          <p className="text-muted-fg text-sm">
            {isTestnet
              ? 'Testnet is Binance’s practice exchange: the prices are real, the money is practice money. Nothing here can gain or lose you anything.'
              : 'Live is the real exchange. Orders placed here spend real money.'}
          </p>
          <p className="text-muted-fg text-sm">
            The environment is fixed by the API key pair this account holds. To trade the other one,
            add another account.
          </p>
        </div>
      </Panel>

      <Panel title="Shortcuts">
        <nav className="grid gap-2">
          <NavCard
            to="/accounts/$accountId/api-key"
            params={{ accountId }}
            title="API key"
            description="The Binance key pair this account trades with."
          />
          <NavCard
            to="/accounts/$accountId/dust-transfer"
            params={{ accountId }}
            title="Dust transfer"
            description="Convert small leftover balances into BNB on Binance."
          />
          <NavCard
            to="/accounts/$accountId/orphan-orders"
            params={{ accountId }}
            title="Orphan orders"
            description="Adopt orders open on Binance that the bot isn't tracking yet."
          />
        </nav>
      </Panel>

      <Panel
        title="Stop all trading"
        description="Emergency stop for every profile in this account at once. Halts new orders; resume each profile from its own page when you are ready."
      >
        <AccountKillSwitch accountId={accountId} className="w-full sm:w-56" />
      </Panel>

      <Panel
        title="Delete account"
        description="Removes this account and every profile, key, and trade record under it. Orders already resting on Binance are NOT cancelled — do that first."
      >
        <Button
          variant="outline"
          data-testid="account-delete"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          className="text-danger w-full sm:w-56"
        >
          Delete account
        </Button>
      </Panel>

      <Dialog open={blocked !== null} onOpenChange={(open) => !open && setBlocked(null)}>
        <DialogContent data-testid="account-delete-blocked-dialog">
          <DialogHeader>
            <DialogTitle>This account still has money on the exchange</DialogTitle>
            <DialogDescription>
              {blocked
                ? `${blocked.openOrderCount} live order(s) and ${blocked.openPositionCount} held position(s) across this account's profiles. Delete each profile first and choose what happens to its orders — the bot then cancels them on Binance for you. Removing the account now would leave those orders open on Binance, holding your coins, with nothing left pointing at them.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button variant="outline" onClick={() => setBlocked(null)}>
              Close
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

export const accountSettingsRoute = createRoute({
  staticData: { title: 'Account settings' },
  getParentRoute: () => accountScopeRoute,
  path: 'settings',
  component: AccountSettingsPage,
});
