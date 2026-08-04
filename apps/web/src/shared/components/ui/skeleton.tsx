import { cn } from '@/shared/lib/cn';

/**
 * One placeholder block, sized by the caller.
 *
 * Decorative by contract: it carries `aria-hidden`, so the surface that owns
 * the loading state announces once via `role="status"` instead of a screen
 * reader walking a wall of empty boxes.
 *
 * The pulse is dropped under `prefers-reduced-motion`. A full page of
 * synchronised pulsing is the vestibular trigger that accessibility guidance on
 * skeleton screens warns about, and the layout still reads without it.
 */
export function Skeleton({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      // Stable hook so tests can count bars without walking wrapper nesting.
      data-skeleton-bar=""
      className={cn('bg-skeleton animate-pulse motion-reduce:animate-none', className)}
    />
  );
}
