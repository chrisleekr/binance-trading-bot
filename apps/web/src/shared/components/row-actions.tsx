import { MoreVertical } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { Button } from '@/shared/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu';
import { cn } from '@/shared/lib/cn';

export interface RowAction {
  /** Stable identity for the React key. */
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Renders in the danger color. The confirm dialog (loud) is the caller's job. */
  destructive?: boolean;
  disabled?: boolean;
  /** Muted subtext under a disabled item so "why can't I?" is never a mystery. */
  disabledReason?: string | undefined;
  testId?: string;
}

interface RowActionsProps {
  actions: RowAction[];
  /** Accessible name for the trigger, e.g. "Actions for SOLUSDT run". */
  label: string;
  testId?: string;
}

// Overflow (kebab) menu for per-row table actions. Keeps a row's columns free of
// buttons — status stays a status, actions live here. A destructive item is quiet
// in the menu and loud in its confirm dialog (the caller owns the dialog). The
// trigger and menu stop event propagation so opening or choosing an action never
// also fires a row-level click/select. Returns null when there are no actions.
export function RowActions({ actions, label, testId }: RowActionsProps): ReactElement | null {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {actions.map((a) => (
          <DropdownMenuItem
            key={a.key}
            disabled={a.disabled ?? false}
            data-testid={a.testId}
            className={cn(
              'flex-col items-start gap-0.5',
              a.destructive && 'text-danger focus:bg-danger focus:text-danger-fg',
            )}
            onSelect={() => a.onSelect()}
          >
            <span className="flex items-center gap-2">
              {a.icon}
              {a.label}
            </span>
            {a.disabled && a.disabledReason ? (
              <span className="text-[11px] text-muted-fg normal-case">{a.disabledReason}</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
