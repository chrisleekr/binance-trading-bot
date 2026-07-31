import { Info } from 'lucide-react';
import type * as React from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover';
import { cn } from '@/shared/lib/cn';

/**
 * A small `ⓘ` affordance next to a label that reveals a plain-language
 * explanation. Click/tap to open (a Popover, not a hover Tooltip) so it works
 * identically on touch and desktop — the operator is mobile-first and hover does
 * not exist on a phone.
 */
export function InfoHint({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  /** Accessible name for the trigger, e.g. the metric it explains. */
  label: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={`What is ${label}?`}
        className={cn(
          'text-muted-fg hover:text-fg focus-visible:ring-focus inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle focus-visible:outline-none focus-visible:ring-2',
          className,
        )}
      >
        <Info className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="text-fg w-64 text-xs leading-relaxed" side="top">
        {children}
      </PopoverContent>
    </Popover>
  );
}
