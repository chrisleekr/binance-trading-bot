import { repo } from '@app/db';
import type { DI } from '../di.js';
import { SINGLE_SIGN_ON_PROVIDER_ID } from '../auth.js';
import { checkDiscovery, type DiscoveryResult } from './single-sign-on.js';

/** How long boot waits for Better Auth to finish initialising before treating the process as wedged. */
export const AUTH_INIT_TIMEOUT_MS: number = 10_000;
/** How often an unavailable identity provider is checked again. */
export const SINGLE_SIGN_ON_REPROBE_MS: number = 5 * 60_000;

/**
 * Checks the identity provider before the app is built, when single sign-on is enabled.
 *
 * @param issuer - The configured issuer, or undefined when single sign-on is off.
 * @returns The discovery outcome, or undefined when there is nothing to check.
 */
export const discoverSingleSignOn = async (
  issuer: string | undefined,
): Promise<DiscoveryResult | undefined> =>
  issuer === undefined ? undefined : checkDiscovery(issuer);

/**
 * Settles which sign-in methods the process offers, after the DI container exists.
 *
 * 1. An enabled but unreachable identity provider is reported (audit, notification, metric) and left off.
 * 2. If the configured methods cannot reach the existing operator (password off and no working single sign-on link, or single sign-on unavailable and no password credential), password sign-in is forced on and reported. Booting an instance nobody can sign in to would leave the kill switch unreachable; the alert makes the override visible, and the reset command is the way to give an operator without a password one.
 * 3. Better Auth's initialisation is awaited with a timeout. It fetches the discovery document again with no timeout of its own, and every request waits on it, so a provider that died between the boot check and this point would hang the whole API. On timeout the process exits and restarts into the degraded path.
 *
 * @param di - The container; its auth instance may be rebuilt.
 * @param discovery - The outcome of {@link discoverSingleSignOn}.
 * @returns Nothing; throws only when Better Auth fails to initialise in time.
 */
export const settleSignInMethods = async (
  di: DI,
  discovery: DiscoveryResult | undefined,
): Promise<void> => {
  const { security } = di;
  if (security.singleSignOn !== null && discovery !== undefined && !discovery.ok) {
    di.logger.error(
      { reason: discovery.reason, issuer: security.singleSignOn.issuer },
      'single_sign_on_unavailable_at_boot',
    );
    await security.events.record({
      event: 'single-sign-on-unavailable',
      actor: 'system',
      reason: discovery.reason === 'issuer_mismatch' ? 'issuer_mismatch' : 'provider_unavailable',
      detail: { cause: discovery.reason },
    });
  }

  const operator = await repo.authIdentity.findSoleUser(di.db);
  if (operator !== null) {
    const providers = await repo.authIdentity.listSignInProviders(di.db, operator.id);
    const passwordWorks = security.passwordSignIn && providers.includes('credential');
    const singleSignOnWorks =
      security.singleSignOnAvailable && providers.includes(SINGLE_SIGN_ON_PROVIDER_ID);
    if (!passwordWorks && !singleSignOnWorks && !security.passwordSignIn) {
      security.passwordSignIn = true;
      security.passwordSignInForced = true;
      di.auth = di.rebuildAuth();
      di.logger.error(
        { providers, singleSignOnAvailable: security.singleSignOnAvailable },
        'sign_in_method_fallback_password_forced_on',
      );
      await security.events.record({
        event: 'sign-in-method-fallback',
        actor: 'system',
        detail: {
          hasPassword: providers.includes('credential'),
          singleSignOnAvailable: security.singleSignOnAvailable,
        },
      });
    } else if (!passwordWorks && !singleSignOnWorks) {
      // Password sign-in is already on, but the operator has no password (they onboarded through single sign-on, which is now unavailable). Nothing the process can switch fixes that; only the reset command can give them a password.
      di.logger.error(
        { providers, singleSignOnAvailable: security.singleSignOnAvailable },
        'no_sign_in_method_reaches_operator_run_reset_password',
      );
      await security.events.record({
        event: 'sign-in-method-fallback',
        actor: 'system',
        reason: 'provider_unavailable',
        detail: {
          hasPassword: false,
          singleSignOnAvailable: security.singleSignOnAvailable,
          remedy: 'run reset-password',
        },
      });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      di.auth.$context,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Better Auth did not initialise in time')),
          AUTH_INIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * While an enabled identity provider is unavailable, checks it again periodically. When it answers correctly, the process asks for a graceful restart so the provider is registered cleanly; Better Auth only reads provider configuration at startup.
 *
 * @param di - The container.
 * @param requestRestart - Called once on recovery; the standalone api sends itself SIGTERM, which the graceful shutdown handles.
 * @returns A stop function for shutdown, or null when there is nothing to watch.
 */
export const watchSingleSignOnRecovery = (
  di: DI,
  requestRestart: () => void,
): (() => void) | null => {
  const config = di.security.singleSignOn;
  if (config === null || di.security.singleSignOnAvailable) return null;
  let stopped = false;
  const interval = setInterval(() => {
    void (async () => {
      const result = await checkDiscovery(config.issuer);
      if (stopped || !result.ok) return;
      stopped = true;
      clearInterval(interval);
      di.security.metrics.singleSignOnAvailable.set({ provider: SINGLE_SIGN_ON_PROVIDER_ID }, 1);
      di.logger.warn({ issuer: config.issuer }, 'single_sign_on_recovered_restarting');
      await di.security.events.record({ event: 'single-sign-on-recovered', actor: 'system' });
      requestRestart();
    })();
  }, SINGLE_SIGN_ON_REPROBE_MS);
  interval.unref?.();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
};
