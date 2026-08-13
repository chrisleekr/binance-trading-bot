/**
 * Next steps: every action that acts on this run — load suggested changes, ask
 * AI, apply to live, pin a baseline — in one place, after the operator has read
 * the outcome. Renders nothing when the route composes neither slot.
 */
export function ResultsActionsSection({
  recommendations,
  actions,
}: {
  readonly recommendations?: React.ReactNode;
  readonly actions?: React.ReactNode;
}): React.JSX.Element | null {
  if (!recommendations && !actions) return null;
  return (
    <section aria-labelledby="bt-next-h" className="space-y-4">
      <h2 id="bt-next-h" className="text-sm font-semibold text-fg">
        What next?
      </h2>
      {recommendations}
      {actions}
    </section>
  );
}
