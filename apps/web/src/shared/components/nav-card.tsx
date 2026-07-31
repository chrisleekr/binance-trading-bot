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
      className="border-border bg-bg-elevated hover:border-accent flex items-center justify-between gap-3 rounded-md border p-3"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-fg text-sm font-medium">{title}</span>
        <span className="text-muted-fg text-sm">{description}</span>
      </span>
      <ChevronRight className="text-muted-fg size-5 shrink-0" aria-hidden="true" />
    </Link>
  );
}
