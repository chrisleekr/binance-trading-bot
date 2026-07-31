import * as React from 'react';

import { cn } from '@/shared/lib/cn';

/**
 * Bordered elevated surface for grouping a panel on a dashboard route. The
 * wrapped panel carries its own heading, so there is no title slot.
 */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('border-border bg-bg-elevated rounded-md border p-4', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';
