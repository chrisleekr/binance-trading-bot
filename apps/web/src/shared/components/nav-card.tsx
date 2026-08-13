// A bordered navigation row (title, description, chevron). The shape every hub
// page uses to point at a deeper surface, in one place so the two hubs (operator
// settings, account settings) cannot drift apart.

import { Link, type LinkProps } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

export function NavCard({
  to,
  params,
  title,
  description,
}: {
  // Reuse the router's own typed route union so a route rename propagates here
  // instead of drifting against a hand-maintained literal list. NonNullable:
  // every nav card has a concrete destination.
  readonly to: NonNullable<LinkProps['to']>;
  readonly params?: LinkProps['params'];
  readonly title: string;
  readonly description: string;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      {...(params ? { params } : {})}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-elevated p-3 hover:border-accent"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{title}</span>
        <span className="text-sm text-muted-fg">{description}</span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-muted-fg" aria-hidden="true" />
    </Link>
  );
}
