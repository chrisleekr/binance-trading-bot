import { AsyncLocalStorage } from 'node:async_hooks';
import type { SignInMethod } from '@app/contracts';

/**
 * Facts one sign-in request learns in pieces. Better Auth calls our hooks (identity provider claims, session creation) deep inside its own handler, where nothing of ours is in scope; this store carries what they learn back out to the route that started the request, without any global state.
 */
export interface AuthRequestContext {
  /** Trusted client address and browser, captured before Better Auth runs. */
  readonly ipAddress: string;
  readonly userAgent: string | null;
  /** How this request signs in, fixed by the route that started it. */
  readonly method: SignInMethod;
  /** Verified identity-provider claims, set by the single sign-on `getUserInfo`. */
  singleSignOn?: {
    /** When the person last authenticated at the identity provider (`auth_time`), in ms. */
    readonly authenticatedAtMs: number | null;
    /** The `email` claim, recorded on the identity for display. */
    readonly email: string;
  };
  /** Set by the session-created hook: the user a session was just issued to. */
  createdSession?: { readonly userId: string; readonly sessionId: string };
  /** Set by the account-created hook when this request attached a single sign-on identity to an existing operator. A link completes without creating a session, so the callback needs this to tell it from a failed sign-in. */
  linkedUserId?: string;
  /** Set when this request created the operator, so an identity attached in the same request is recognised as part of onboarding rather than a later link. */
  onboardedUserId?: string;
  /** Set when the single sign-on login was refused for a reason Better Auth cannot express, so the callback can report it. */
  refusalReason?: 'issuer_mismatch' | 'missing_id_token';
}

const storage = new AsyncLocalStorage<AuthRequestContext>();

/**
 * Runs `fn` with a fresh request context.
 *
 * @param context - The initial facts; hooks add to it while `fn` runs.
 * @param fn - The work, normally a Better Auth call.
 * @returns Whatever `fn` returns.
 */
export const runWithAuthRequestContext = <T>(
  context: AuthRequestContext,
  fn: () => Promise<T>,
): Promise<T> => storage.run(context, fn);

/**
 * The context of the request currently running, if one was started.
 *
 * @returns The live, mutable context, or undefined outside {@link runWithAuthRequestContext} (for example the command-line tools).
 */
export const currentAuthRequestContext = (): AuthRequestContext | undefined => storage.getStore();
