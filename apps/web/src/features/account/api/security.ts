import {
  ActiveSessionList,
  AuthSecuritySettings,
  SecurityEventPage,
  SessionResponse,
  type Reauthentication,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';

const EmptyResponse = z.unknown();

/** Cache keys for the security page. The session key is shared with the rest of the app, so a change made here (adding a password, linking single sign-on) refreshes every screen that reads the signed-in operator. */
export const securityQueryKeys = {
  session: ['auth', 'session'] as const,
  sessions: ['auth', 'sessions'] as const,
  settings: ['auth', 'security-settings'] as const,
  events: ['auth', 'security-events'] as const,
};

/**
 * The signed-in operator and which sign-in methods they have, used to decide which actions the security page offers.
 *
 * @returns Whether a password is set and whether single sign-on is linked, alongside the operator's identity.
 */
export const fetchSession = (): Promise<SessionResponse> =>
  apiFetch('/auth/session', SessionResponse);

/**
 * Every browser currently signed in as the operator, so an unrecognised one can be signed out.
 *
 * @returns The sessions, with the one making this request marked `current`.
 */
export const fetchSessions = (): Promise<ActiveSessionList> =>
  apiFetch('/auth/sessions', ActiveSessionList);

/**
 * The sign-in limits in force, validated against the same contract the server enforces so the form edits exactly what the server stores.
 *
 * @returns The full settings document.
 */
export const fetchSecuritySettings = (): Promise<AuthSecuritySettings> =>
  apiFetch('/auth/security-settings', AuthSecuritySettings);

/**
 * One page of security activity, newest first.
 *
 * @param before - The previous page's `nextBefore`, or undefined for the first page.
 * @returns The page and the cursor for the next one.
 */
export const fetchSecurityEvents = (before: string | undefined): Promise<SecurityEventPage> =>
  apiFetch('/auth/security-events', SecurityEventPage, {
    method: 'GET',
    query: { limit: 25, before },
  });

/**
 * Signs out one other browser. No proof is asked for because this only removes access, never grants it.
 *
 * @param sessionId - The `id` from `fetchSessions` of the browser to sign out; it is a session row id, never the session token.
 * @returns The server's empty acknowledgement.
 */
export const revokeSession = (sessionId: string): Promise<unknown> =>
  apiFetch(`/auth/sessions/${encodePathSegment(sessionId)}/revoke`, EmptyResponse, {
    method: 'POST',
    body: {},
  });

/**
 * Signs out every browser except this one, the first step after spotting an unrecognised sign-in.
 *
 * @returns The server's empty acknowledgement.
 */
export const revokeOtherSessions = (): Promise<unknown> =>
  apiFetch('/auth/sessions/revoke-others', EmptyResponse, { method: 'POST', body: {} });

/**
 * Signs out every browser including this one, forgets recognised devices, and ends agent access. It needs proof because it also drops the caller's own session.
 *
 * @param reauthentication - Proof the operator is at the keyboard: the current password, or a recent single sign-on.
 * @returns The server's empty acknowledgement.
 */
export const signOutEverywhere = (reauthentication: Reauthentication): Promise<unknown> =>
  apiFetch('/auth/sign-out-everywhere', EmptyResponse, {
    method: 'POST',
    body: { reauthentication },
  });

/**
 * Ends every AI agent approval at once, including access tokens the agents already hold.
 *
 * @returns The server's empty acknowledgement.
 */
export const revokeAgentAccess = (): Promise<unknown> =>
  apiFetch('/auth/agent-access/revoke', EmptyResponse, { method: 'POST', body: {} });

/**
 * Adds a password for an operator who signs in only with single sign-on, so they keep a way in if the identity provider is unreachable.
 *
 * @param newPassword - The password to add, at least 12 characters.
 * @param reauthentication - Proof the operator is at the keyboard, required because a new credential is being created.
 * @returns The server's empty acknowledgement.
 */
export const setPassword = (
  newPassword: string,
  reauthentication: Reauthentication,
): Promise<unknown> =>
  apiFetch('/auth/password', EmptyResponse, {
    method: 'POST',
    body: { newPassword, reauthentication },
  });

/**
 * Starts linking the operator's identity provider account. The server answers with the provider's address rather than redirecting, so the page can surface a refusal before leaving.
 *
 * @param reauthentication - Proof the operator is at the keyboard, required because linking adds a way to sign in.
 * @returns The identity provider address to send the browser to.
 */
export const linkSingleSignOn = (reauthentication: Reauthentication): Promise<{ url: string }> =>
  apiFetch('/auth/single-sign-on/link', z.object({ url: z.url() }), {
    method: 'POST',
    body: { reauthentication },
  });

/**
 * Removes the linked identity provider account. The server refuses when that would leave no way to sign in.
 *
 * @param reauthentication - Proof the operator is at the keyboard, required because a sign-in method is being removed.
 * @returns The server's empty acknowledgement.
 */
export const unlinkSingleSignOn = (reauthentication: Reauthentication): Promise<unknown> =>
  apiFetch('/auth/single-sign-on/unlink', EmptyResponse, {
    method: 'POST',
    body: { reauthentication },
  });

/**
 * Saves the sign-in limits. The whole document is sent so the server validates the combination (for example a first block no longer than the longest block), not each field alone.
 *
 * @param settings - The complete settings document, already checked against the shared contract.
 * @param reauthentication - Proof the operator is at the keyboard, required because looser limits make password guessing easier.
 * @returns The settings as the server stored them.
 */
export const updateSecuritySettings = (
  settings: AuthSecuritySettings,
  reauthentication: Reauthentication,
): Promise<AuthSecuritySettings> =>
  apiFetch('/auth/security-settings', AuthSecuritySettings, {
    method: 'PATCH',
    body: { settings, reauthentication },
  });
