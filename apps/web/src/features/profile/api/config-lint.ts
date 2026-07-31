import { ConfigLintResponse } from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** Query key for a profile config lint, keyed by profile + the config linted. */
export const configLintQueryKey = (profileId: string, config: unknown): readonly unknown[] => [
  'config-lint',
  profileId,
  config,
];

/**
 * POST /profiles/:id/lint-config — diagnostics for a config: the strategy's
 * settings lint (inert / conflicting settings) plus the per-symbol order
 * feasibility check (orders below the exchange minimum, or a grid the balance
 * can't fund). `block`-level findings mean the config cannot trade and the save
 * mutation rejects it. Empty when clean.
 */
export const lintConfig = (profileId: string, config: unknown): Promise<ConfigLintResponse> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/lint-config`),
    ConfigLintResponse,
    {
      method: 'POST',
      body: { config },
    },
  );
