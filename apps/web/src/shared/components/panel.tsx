import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/shared/lib/cn';

/**
 * The one titled-panel container for editor/settings surfaces: a bordered
 * elevated box, a header (title + optional one-line description), a hairline,
 * then the body. `collapsible` renders the header as a native `<details>`
 * disclosure with a chevron; the static form is a plain `<section>` header.
 *
 * A panel that reads as a disclosure (chevron) MUST actually collapse — so
 * `collapsible` gates both the chevron and the `<details>` element together.
 * Content that was never collapsible stays static, so the affordance never
 * lies about what a click does.
 */
export function Panel({
  title,
  description,
  actions,
  collapsible = false,
  defaultOpen = true,
  children,
  className,
  testId,
  summaryTestId,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Header-right slot, e.g. a live status Badge. Keep it non-interactive on a
   *  collapsible panel — a click inside the summary toggles the disclosure. */
  readonly actions?: ReactNode;
  readonly collapsible?: boolean;
  /** Open state on first render; only meaningful when `collapsible`. */
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
  /** Test id for the disclosure toggle, set on the `<summary>` of a collapsible
   *  panel so a test can click it to expand. */
  readonly summaryTestId?: string;
}): React.JSX.Element {
  const box = cn('border border-border bg-bg-elevated', className);
  const body = <div className="border-t border-border p-4">{children}</div>;

  if (collapsible) {
    // A <summary> allows phrasing content only, so the title and description are
    // spans (a <div>/<h2>/<p> here would be non-conforming HTML).
    return (
      <details open={defaultOpen} className={cn('group', box)} data-testid={testId}>
        <summary
          data-testid={summaryTestId}
          className="flex cursor-pointer list-none items-start justify-between gap-2 px-4 py-3 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none [&::-webkit-details-marker]:hidden"
        >
          <span className="block min-w-0">
            <span className="text-sm font-semibold text-fg">{title}</span>
            {description ? (
              <span className="mt-0.5 block text-xs leading-relaxed font-normal text-muted-fg">
                {description}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {actions}
            <ChevronDown
              className="mt-0.5 h-4 w-4 text-muted-fg transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <section className={box} data-testid={testId}>
      <div className="flex items-start justify-between gap-2 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-fg">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {body}
    </section>
  );
}
