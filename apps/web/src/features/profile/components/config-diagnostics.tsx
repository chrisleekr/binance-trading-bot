// Config diagnostics banner. Shows, above the config form, both the strategy's
// advisory settings lint (silently inert or conflicting settings) and the
// per-symbol order-feasibility check (orders below the exchange minimum, or a
// grid the balance can't fund). `block`-level findings render as a danger banner
// because the save mutation rejects them; `warn` / `info` render as advisory.
// Loading / error render nothing — a lint failure must never blank the form.

import { useQuery } from '@tanstack/react-query';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { configLintQueryKey, lintConfig } from '@/features/profile/api/config-lint';

export function ConfigDiagnostics({
  profileId,
  config,
}: {
  readonly profileId: string;
  readonly config: unknown;
}): React.JSX.Element | null {
  const q = useQuery({
    queryKey: configLintQueryKey(profileId, config),
    queryFn: () => lintConfig(profileId, config),
    // Advisory surface; a failed lint shows nothing rather than an error surface.
    retry: false,
  });

  const diagnostics = q.data?.diagnostics ?? [];
  if (diagnostics.length === 0) return null;

  // Block-level findings (the config can't trade) render as danger; advisory
  // warn/info findings render as a warning. Same list markup either way.
  const groups = [
    {
      testid: 'config-diagnostics-block',
      variant: 'danger' as const,
      title: 'This config can’t place a valid order',
      items: diagnostics.filter((d) => d.level === 'block'),
    },
    {
      testid: 'config-diagnostics',
      variant: 'warning' as const,
      title: 'Some settings won’t do what you expect',
      items: diagnostics.filter((d) => d.level !== 'block'),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <Alert key={g.testid} variant={g.variant} data-testid={g.testid}>
          <AlertTitle>{g.title}</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-1.5">
              {/*
                Per-symbol findings repeat one code across a multi-symbol basket,
                so the code alone is not a unique key — keying by it collapses
                siblings in the reconciler and hides all but one symbol. The
                index restarts per group, so the testid also carries the level:
                unlike a key, it has to be unique across the whole document.
              */}
              {g.items.map((d, i) => (
                <li
                  key={`${d.code}-${i}`}
                  className="text-sm"
                  data-testid={`config-diagnostic-${d.level}-${d.code}-${i}`}
                >
                  {d.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
