import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from '@tanstack/react-router';
import { ChevronsUpDown, Plus, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/shared/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';

// Profile switcher: the second scope level, below the account. URL-driven — the
// active profile is the route's `$profileId`, and selecting one navigates to
// that profile's dashboard under the active account. "All profiles" navigates
// to the account overview.
export function ProfileSwitcher() {
  const accountId = useActiveAccountId() ?? '';
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const profiles = data?.profiles ?? [];
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // The URL owns the focus: the route's `$profileId` is the active profile, or
  // null on the account overview (`/accounts/$accountId`).
  const routeProfileId = useParams({ strict: false }).profileId ?? null;

  const killSwitchActive = profiles.some((p) => p.killSwitch);

  const shownProfile = profiles.find((p) => p.profileId === routeProfileId) ?? null;
  const triggerLabel = shownProfile
    ? shownProfile.name
    : profiles.length === 0
      ? t('profile.switcher.no_active')
      : t('profile.switcher.all');

  // Active profile sorts to the top; "All profiles" is a fixed first entry.
  const sorted = [...profiles].sort((a, b) => {
    if (a.profileId === routeProfileId) return -1;
    if (b.profileId === routeProfileId) return 1;
    return a.name.localeCompare(b.name);
  });

  const onSelectProfile = (profileId: string): void => {
    setOpen(false);
    void router.navigate({
      to: '/accounts/$accountId/profiles/$profileId',
      params: { accountId, profileId },
    });
  };

  const onSelectAll = (): void => {
    setOpen(false);
    void router.navigate({ to: '/accounts/$accountId', params: { accountId } });
  };

  const onCreateProfile = (): void => {
    setOpen(false);
    void router.navigate({ to: '/accounts/$accountId/profiles/new', params: { accountId } });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={
            killSwitchActive
              ? `${t('profile.switcher.label')} · ${t('profile.switcher.kill_switch')}`
              : t('profile.switcher.label')
          }
          data-testid="profile-switcher-trigger"
          // normal-case + text-sm: the trigger shows an operator-named profile,
          // not a static label — the terminal uppercase would distort it.
          className="h-11 max-w-[16rem] justify-between gap-2 truncate text-sm font-medium tracking-normal normal-case"
        >
          <span className="flex min-w-0 items-center gap-2">
            {killSwitchActive && (
              <ShieldAlert
                aria-hidden="true"
                data-testid="profile-switcher-killswitch"
                className="h-4 w-4 shrink-0 text-danger"
              />
            )}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={t('profile.switcher.placeholder')} />
          <CommandList>
            <CommandEmpty>{t('profile.switcher.empty')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t('profile.switcher.all')}
                onSelect={onSelectAll}
                data-testid="profile-switcher-item-all"
                className={cn(
                  'flex min-h-11 items-center gap-2',
                  routeProfileId === null && 'font-semibold',
                )}
              >
                <span className="truncate">{t('profile.switcher.all')}</span>
              </CommandItem>
              {sorted.map((p) => (
                <CommandItem
                  key={p.profileId}
                  value={`${p.name} ${p.profileId}`}
                  onSelect={() => onSelectProfile(p.profileId)}
                  data-testid={`profile-switcher-item-${p.profileId}`}
                  className={cn(
                    'flex min-h-11 items-center gap-2',
                    p.profileId === routeProfileId && 'font-semibold',
                  )}
                >
                  {p.killSwitch && (
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
                  )}
                  <span className="truncate">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {/* Creating a profile lives with choosing one, mirroring the account
                switcher's "New account". The overview no longer carries a
                separate button competing with the trading controls. */}
            <CommandGroup>
              <CommandItem
                value={t('nav.new_profile')}
                onSelect={onCreateProfile}
                data-testid="profile-switcher-new"
                className="flex min-h-11 items-center gap-2"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('nav.new_profile')}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
