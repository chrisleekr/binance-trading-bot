import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

/**
 * The one action-button row for form and dialog footers: right-aligned so the
 * primary action lands where the eye settles, and wrapping so a two- or
 * three-button row never overflows the 375px mobile frame. Row-level extras (a
 * top hairline, a margin, a wider gap) ride in through `className`.
 */
export function FormActions({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return <div className={cn('flex flex-wrap justify-end gap-2', className)}>{children}</div>;
}
