// `/settings` — the operator-level surface. Everything here belongs to the login
// itself and is true no matter which Binance account is in view: the timezone
// times render in, the ops notification toggles, the AI provider, how long logs
// are kept, the password, the session, and the whole-database backup.
//
// Anything that acts on ONE account's wallet, key pair, or order book (dust
// transfer, orphan orders, stop-all-trading) lives on that account's own
// settings page. Mixing the two forced this page to guess an account id, and a
// wrong guess there is a link into the void.

import type { ChangePasswordRequest } from '@app/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createRoute, Outlet, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { NavCard } from '@/shared/components/nav-card';
import { Page, PageHeader } from '@/shared/components/page';
import { Panel } from '@/shared/components/panel';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { apiFetch } from '@/shared/lib/api';
import { accountSettingsQueryKey, updateTimezone } from '@/features/account/api/account-settings';
import { useTimezone } from '@/shared/context/timezone-context';
import { OpsNotifyCard } from '@/features/account/components/ops-notify-card';
import { AiProviderCard } from '@/features/account/components/ai-provider-card';
import { OpsHealthPanel } from '@/features/account/components/ops-health-panel';
import { RetentionSettingsCard } from '@/features/account/components/retention-settings-card';
import { rootRoute } from '@/app/__root';
import { Select } from '@/shared/components/ui/select';

const EmptyResponse = z.unknown();

const changePassword = (body: ChangePasswordRequest): Promise<unknown> =>
  apiFetch('/auth/change-password', EmptyResponse, { method: 'POST', body });

const signOut = (): Promise<unknown> =>
  apiFetch('/auth/sign-out', EmptyResponse, { method: 'POST', body: {} });

interface FieldErrors {
  oldPassword?: string;
  newPassword?: string;
  confirm?: string;
}

// IANA zones with 'UTC' pinned first. Computed once at module load: the host's
// zone table does not change between renders, and `supportedValuesOf` is not
// cheap to call per keystroke.
const TIMEZONE_OPTIONS: readonly string[] = (() => {
  const all = Intl.supportedValuesOf('timeZone');
  const rest = all.filter((z) => z !== 'UTC');
  return ['UTC', ...rest];
})();

function SettingsPage(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();

  const timezone = useTimezone();
  const [tzBanner, setTzBanner] = useState<ActionBannerState | null>(null);
  const [tzSubmitting, setTzSubmitting] = useState(false);

  const onChangeTimezone = async (next: string): Promise<void> => {
    setTzBanner(null);
    setTzSubmitting(true);
    try {
      await updateTimezone({ timezone: next });
      await queryClient.invalidateQueries({ queryKey: accountSettingsQueryKey });
      setTzBanner({ kind: 'ok', message: `Times now shown in ${next}.` });
    } catch (err) {
      setTzBanner({
        kind: 'err',
        message: err instanceof Error ? err.message : 'could not update timezone',
      });
    } finally {
      setTzSubmitting(false);
    }
  };

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pwBanner, setPwBanner] = useState<ActionBannerState | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const [signOutBanner, setSignOutBanner] = useState<ActionBannerState | null>(null);
  const [signOutSubmitting, setSignOutSubmitting] = useState(false);

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!oldPassword) next.oldPassword = 'required';
    if (!newPassword) next.newPassword = 'required';
    else if (newPassword.length < 12) next.newPassword = 'must be at least 12 characters';
    if (newPassword !== confirm) next.confirm = 'does not match';
    return next;
  };

  const onChangePassword = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPwBanner(null);
    const fieldErrors = validate();
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;
    setPwSubmitting(true);
    try {
      await changePassword({ oldPassword, newPassword });
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setPwBanner({ kind: 'ok', message: 'Password updated.' });
    } catch (err) {
      setPwBanner({
        kind: 'err',
        message: err instanceof Error ? err.message : 'change-password failed',
      });
    } finally {
      setPwSubmitting(false);
    }
  };

  const onSignOut = async (): Promise<void> => {
    setSignOutBanner(null);
    setSignOutSubmitting(true);
    try {
      await signOut();
      // Only navigate to /login on a confirmed server-side sign-out. Routing
      // away on failure looked like success but left the session cookie valid,
      // so operators thought they were signed out when they weren't.
      await router.navigate({ to: '/login' });
    } catch (err) {
      setSignOutBanner({
        kind: 'err',
        message: err instanceof Error ? err.message : 'sign-out failed',
      });
    } finally {
      setSignOutSubmitting(false);
    }
  };

  return (
    <Page>
      <PageHeader title="Settings" />

      <Panel
        title="Timezone"
        description="Times across the app show in UTC alongside your chosen timezone, so a timestamp reads the same no matter where you open it."
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="account-timezone">Timezone</Label>
            <Select
              id="account-timezone"
              data-testid="account-timezone-select"
              value={timezone}
              disabled={tzSubmitting}
              onChange={(e) => void onChangeTimezone(e.target.value)}
              className="w-full sm:w-72"
            >
              {TIMEZONE_OPTIONS.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </div>
          <ActionBanner banner={tzBanner} />
        </div>
      </Panel>

      <OpsNotifyCard />

      <AiProviderCard />

      <OpsHealthPanel />

      <RetentionSettingsCard />

      <Panel title="Shortcuts">
        <nav className="grid gap-2">
          <NavCard
            to="/settings/backup-restore"
            title="Backup & restore"
            description="Export the whole configuration or restore it from a backup."
          />
        </nav>
      </Panel>

      <Panel title="Change password">
        <form onSubmit={onChangePassword} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="account-old-password">Current password</Label>
            <Input
              id="account-old-password"
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoComplete="current-password"
            />
            {errors.oldPassword ? (
              <p className="text-sm text-danger">{errors.oldPassword}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="account-new-password">New password</Label>
            <Input
              id="account-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            {errors.newPassword ? (
              <p className="text-sm text-danger">{errors.newPassword}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="account-confirm-password">Confirm new password</Label>
            <Input
              id="account-confirm-password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {errors.confirm ? <p className="text-sm text-danger">{errors.confirm}</p> : null}
          </div>
          <ActionBanner banner={pwBanner} />
          <Button
            type="submit"
            variant="default"
            disabled={pwSubmitting}
            className="w-full sm:w-56"
          >
            {pwSubmitting ? 'Updating…' : 'Update password'}
          </Button>
        </form>
      </Panel>

      <Panel title="Session">
        <div className="space-y-3">
          <ActionBanner banner={signOutBanner} />
          {/* Outline, not solid red: red is reserved for the trading
              emergency, so a routine sign-out doesn't compete with it. */}
          <Button
            onClick={onSignOut}
            disabled={signOutSubmitting}
            variant="outline"
            className="w-full sm:w-56"
          >
            {signOutSubmitting ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </Panel>
    </Page>
  );
}

/**
 * `/settings` as a LAYOUT, not a leaf. Backup & restore lives at
 * `/settings/backup-restore`, so the URL already says it nests here; the route
 * tree used to disagree, which left that page with no ancestor match and so no
 * breadcrumb to orient by once its `Back` link was removed.
 */
export const settingsRoute = createRoute({
  staticData: { title: 'Settings' },
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: () => <Outlet />,
});

export const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: SettingsPage,
});
