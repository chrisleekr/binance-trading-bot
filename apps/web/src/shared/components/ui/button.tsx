import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/shared/lib/cn';

const buttonVariants = cva(
  // Terminal treatment: uppercase, letter-spaced, square (radius scale is 0).
  // Buttons that display operator data (profile names) opt out via normal-case.
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xs text-xs font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // Blue: commit a configured value (SAVE, UPDATE, selection).
        default: 'bg-accent text-accent-fg hover:opacity-90',
        // Mint green: irreversible "go" + positive (RUN, GO, BUY, Manual Order).
        primary: 'bg-primary text-primary-fg hover:opacity-90',
        outline: 'border border-border bg-transparent text-fg hover:bg-bg-elevated',
        ghost: 'text-fg hover:bg-bg-elevated',
        // Red: destructive (CANCEL, KILL-SWITCH, SIGN OUT, delete).
        destructive: 'bg-danger text-danger-fg hover:opacity-90',
      },
      size: {
        default: 'h-11 px-4 min-w-11', // ≥44×44 px touch target
        sm: 'h-9 px-3',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    // Default native <button> to type="button" so it doesn't accidentally
    // submit a surrounding <form>. Slot inherits its child's element type.
    const typeProp = asChild ? {} : { type: type ?? 'button' };
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...typeProp}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
