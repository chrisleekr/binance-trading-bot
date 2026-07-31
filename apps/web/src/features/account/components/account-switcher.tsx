import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ChevronsUpDown, Plus, Settings } from 'lucide-react';
import { useState } from 'react';

import { accountsQueryOptions } from '@/features/account/api/accounts';
import { Badge } from '@/shared/components/ui/badge';
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

// Account switcher: the top of the scope stack. Selecting an account navigates
// to its dashboard (URL-driven — the account is always named in the request),
// which switches the ProfileSwitcher below it to that account's profiles.

export function AccountSwitcher() {
  const { data } = useQuery(accountsQueryOptions);
  const accounts = data ?? [];
  const router = useRouter();
  const activeId = useActiveAccountId();
  const [open, setOpen] = useState(false);

  const active = accounts.find((a) => a.id === activeId) ?? null;
  const triggerLabel = active?.name ?? (accounts.length === 0 ? 'No account' : 'Select account');

  const onSelect = (accountId: string): void => {
    setOpen(false);
    if (accountId === activeId) return;
    void router.navigate({ to: '/accounts/$accountId', params: { accountId } });
  };

  const onAdd = (): void => {
    setOpen(false);
    void router.navigate({ to: '/accounts/new' });
  };

  const onManage = (): void => {
    setOpen(false);
    if (!activeId) return;
    void router.navigate({
      to: '/accounts/$accountId/settings',
      params: { accountId: activeId },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Switch account"
          data-testid="account-switcher-trigger"
          className="h-11 max-w-[14rem] justify-between gap-2 truncate text-sm font-medium normal-case tracking-normal"
        >
          {/* No env badge here: the trigger is always on screen, and a
              permanent badge next to the trading status reads as an alert. It
              earns its place in the list below, where it is what tells two
              accounts apart at the moment of choosing. */}
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search accounts…" />
          <CommandList>
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup>
              {accounts.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.name} ${a.id}`}
                  onSelect={() => onSelect(a.id)}
                  data-testid={`account-switcher-item-${a.id}`}
                  className={cn(
                    'flex min-h-11 items-center gap-2',
                    a.id === activeId && 'font-semibold',
                  )}
                >
                  <span className="truncate">{a.name}</span>
                  {a.binanceMode === 'test' && (
                    <Badge variant="outline" className="ml-auto shrink-0">
                      {t('home.card.testnet')}
                    </Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              {/* The only way into the account's own settings: it is a property
                  of the account, so it hangs off the control that names one. */}
              {activeId ? (
                <CommandItem
                  value="manage account"
                  onSelect={onManage}
                  data-testid="account-switcher-manage"
                  className="flex min-h-11 items-center gap-2"
                >
                  <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Manage account</span>
                </CommandItem>
              ) : null}
              <CommandItem
                value="add account"
                onSelect={onAdd}
                data-testid="account-switcher-add"
                className="flex min-h-11 items-center gap-2"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>New account</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
