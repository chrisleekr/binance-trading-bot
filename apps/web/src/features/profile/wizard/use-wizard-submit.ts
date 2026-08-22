import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useRef } from 'react';

import { createProfile } from '@/features/profile/api/profiles-mutations';
import type { WizardAction, WizardState } from '@/features/profile/wizard/reducer';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { ApiError, ValidationFailedError } from '@/shared/lib/api';
import { t } from '@/shared/lib/i18n';

import { ProfileCreate } from '@app/contracts';

import type { Dispatch } from 'react';

/**
 * Wizard submit orchestration. The strategy step maps onto `POST /profiles`
 * under the active account, creating the profile with the strategy's default
 * config; the operator lands on the profile's config page to tune it. Creation
 * is the irreversible step, so a created `profileId` is recorded in state — a
 * retry after a failure does not create a duplicate profile. The profile is
 * created with no symbols; the operator adds them from the profile page
 * afterward. The Binance API key is account-level, set separately on the account
 * api-key page — the wizard collects neither.
 *
 * `config` is passed by the caller (the strategy's default config) rather than
 * read from state; the wizard no longer holds a config draft.
 */
export function useWizardSubmit(
  state: WizardState,
  dispatch: Dispatch<WizardAction>,
): (config?: unknown, strategyOverride?: NonNullable<WizardState['strategy']>) => Promise<void> {
  const router = useRouter();
  const queryClient = useQueryClient();
  const accountId = useActiveAccountId() ?? '';
  // Synchronous re-entrancy guard. `state.creating` only disables the submit
  // button after an async re-render, leaving a window where a fast double
  // activation fires `POST /profiles` twice. A ref blocks the second call
  // immediately; it resets in `finally` so a failed create can still retry.
  const inFlight = useRef(false);

  return async (
    config?: unknown,
    strategyOverride?: NonNullable<WizardState['strategy']>,
  ): Promise<void> => {
    const strategy = strategyOverride ?? state.strategy;
    if (!strategy) return;
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: 'set-creating', creating: true });
    dispatch({ type: 'set-error', error: null });

    let profileId = state.profileId;
    try {
      if (!profileId) {
        const body = ProfileCreate.parse({
          name: state.name,
          strategyName: strategy.name,
          strategyVersion: strategy.version,
          config: config ?? {},
        });
        const created = await createProfile(body);
        profileId = created.id;
        dispatch({ type: 'set-profile-id', profileId });
      }

      // The aggregate drives the switcher, /profiles list, and home; invalidate
      // so the new profile is present the instant the route lands, not only
      // after the 5s refetch interval.
      await queryClient.invalidateQueries({ queryKey: ['dashboard-aggregate', accountId] });
      await router.navigate({
        to: '/accounts/$accountId/profiles/$profileId/config',
        params: { accountId, profileId },
      });
    } catch (cause) {
      const message =
        cause instanceof ValidationFailedError
          ? t('wizard.error.server_validation')
          : cause instanceof ApiError && cause.message
            ? cause.message
            : t('wizard.error.generic');
      dispatch({ type: 'set-error', error: message });
    } finally {
      inFlight.current = false;
      dispatch({ type: 'set-creating', creating: false });
    }
  };
}
