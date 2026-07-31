import * as React from 'react';

import { cn } from '@/shared/lib/cn';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'rounded-xs border-border bg-surface-alt placeholder:text-muted-fg focus-visible:border-focus focus-visible:ring-focus flex h-11 w-full border px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
