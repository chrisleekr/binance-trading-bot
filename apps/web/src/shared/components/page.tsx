// Page shell primitives: one container + one header for every document-style
// route (account/*, profiles/*/{history,backtest}, research, new
// profile). Before this, each route hand-rolled its own header markup, so the
// title size, foreground token, meta placement, and back-link label drifted
// page to page. Routing all of them through `Page` + `PageHeader` makes that
// drift impossible.
//
// `Page` is a <div>, never a <main>: the app shell already owns the <main>
// landmark and its p-4 padding, so a route-level <main> nests a second landmark
// and doubles the horizontal padding. The container only owns vertical rhythm.

import type { ReactNode } from 'react';

import { Breadcrumb } from '@/shared/components/breadcrumb';
import { cn } from '@/shared/lib/cn';

export function Page({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={cn('space-y-6', className)}>{children}</div>;
}

export function PageHeader({
  title,
  meta,
  description,
  actions,
}: {
  title: ReactNode;
  /** Muted text shown inline after the title, e.g. the profile name. */
  meta?: ReactNode;
  /** One-line context shown under the title. */
  description?: ReactNode;
  /** Right-aligned controls on the title row, e.g. status pill + Manage button. */
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="space-y-1">
      {/* The trail is derived from the active route, so a page states its own address without its route file having to name its ancestors. Replaces the former per-page `back` slot, which said a step existed but never where it led. */}
      <Breadcrumb />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h1 className="text-xl font-semibold text-fg">{title}</h1>
          {meta ? <span className="text-sm text-muted-fg">{meta}</span> : null}
        </div>
        {/* ml-auto, not just justify-between: once the row wraps (narrow screen,
            long title) the actions land on their own line, where
            justify-between has nothing to push them against and they slide
            left. ml-auto holds the right edge in both states. */}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
      {description ? <p className="text-sm text-muted-fg">{description}</p> : null}
    </header>
  );
}
