import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/shared/lib/cn';

const badgeVariants = cva(
  // Terminal badge: square, uppercase, hairline border in the semantic colour
  // over a tinted fill. Badges carrying literal data (git SHAs) opt out of the
  // case transform via normal-case.
  'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide transition-colors',
  {
    variants: {
      variant: {
        default: 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] tint-accent',
        secondary: 'border-border-strong bg-bg-elevated text-fg',
        outline: 'border-border-strong text-fg',
        warning: 'border-[color-mix(in_srgb,var(--warning)_45%,transparent)] tint-warning',
        danger: 'border-[color-mix(in_srgb,var(--danger)_45%,transparent)] tint-danger',
        // Technicals ratings: tinted semantic fill (STRONG BUY / SELL).
        up: 'border-[color-mix(in_srgb,var(--up)_40%,transparent)] tint-up',
        down: 'border-[color-mix(in_srgb,var(--down)_40%,transparent)] tint-down',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
