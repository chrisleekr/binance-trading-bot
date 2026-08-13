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
      'flex h-11 w-full rounded-xs border border-border bg-surface-alt px-3 py-2 text-base placeholder:text-muted-fg focus-visible:border-focus focus-visible:ring-1 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
