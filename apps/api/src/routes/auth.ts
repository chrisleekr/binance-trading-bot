import {
  ActiveSessionList,
  AuthSecuritySettings,
  ChangePasswordRequest,
  ErrorEnvelope,
  OnboardingStatus,
  Reauthentication,
  SecurityEventPage,
  SecurityEventRow,
  SessionResponse,
  SetPasswordRequest,
  SignInRequest,
  SignUpRequest,
  SingleSignOnRedirect,
  SingleSignOnStartRequest,
  UpdateAuthSecuritySettingsRequest,
  type SecurityEventReason,
  type UserId,
} from '@app/contracts';
import { repo } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { SINGLE_SIGN_ON_PROVIDER_ID } from 'auth.js';
import { clientIpFromHeaders } from 'auth/client-address.js';
import { authGateway, knownDeviceCookieFor, singleSignOnReady } from 'auth/gateway.js';
import {
  rateLimitedResponse,
  readKnownDevice,
  sameOriginPath,
  withCookiesFrom,
} from 'auth/http.js';
import { isKnownDevice } from 'auth/known-device.js';
import { PasswordCheckOverloadedError } from 'auth/password-check-gate.js';
import { ReauthenticationLimitedError, requireReauthentication } from 'auth/reauthentication.js';
import { runWithAuthRequestContext, type AuthRequestContext } from 'auth/request-context.js';
import { publishSessionRevocation } from 'auth/session-revocation.js';
import { normalizeEmail, type Attempt } from 'auth/sign-in-protection.js';
import type { DI } from 'di.js';
import { compositeCursor, splitCompositeCursor } from 'lib/cursor.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { createApiHono, type ApiHono, type Env } from 'types.js';

const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });
const errors = {
  401: { description: 'not signed in, or the email or password is wrong', ...json(ErrorEnvelope) },
  403: { description: 'refused, including a wrong confirmation password', ...json(ErrorEnvelope) },
  404: { description: 'not available on this deployment', ...json(ErrorEnvelope) },
  429: { description: 'too many attempts; see Retry-After', ...json(ErrorEnvelope) },
};
const Ok = z.object({ ok: z.literal(true) });
/** Delimiter of the security-event page cursor, `<created-at ISO>|<row id>`; already emitted to clients as `nextBefore`. */
const SECURITY_EVENT_CURSOR_SEPARATOR = '|';

const onboardingStatusRoute = createRoute({
  method: 'get',
  path: '/onboarding-status',
  tags: ['auth'],
  responses: {
    200: {
      description: 'onboarding status and the sign-in methods on offer',
      ...json(OnboardingStatus),
    },
  },
});
const signUpRoute = createRoute({
  method: 'post',
  path: '/sign-up',
  tags: ['auth'],
  request: { body: json(SignUpRequest) },
  responses: { 200: { description: 'operator created and signed in', ...json(Ok) }, ...errors },
});
const signInRoute = createRoute({
  method: 'post',
  path: '/sign-in/email',
  tags: ['auth'],
  request: { body: json(SignInRequest) },
  responses: {
    200: { description: 'signed in; the session is in the cookie, never the body', ...json(Ok) },
    ...errors,
  },
});
const signOutRoute = createRoute({
  method: 'post',
  path: '/sign-out',
  tags: ['auth'],
  responses: { 200: { description: 'signed out', ...json(Ok) } },
});
const singleSignOnStartRoute = createRoute({
  method: 'post',
  path: '/single-sign-on/start',
  tags: ['auth'],
  request: { body: json(SingleSignOnStartRequest) },
  responses: {
    200: { description: 'identity provider address to navigate to', ...json(SingleSignOnRedirect) },
    ...errors,
  },
});
const sessionRoute = createRoute({
  method: 'get',
  path: '/session',
  tags: ['auth'],
  responses: {
    200: { description: 'the signed-in operator', ...json(SessionResponse) },
    ...errors,
  },
});
const changePasswordRoute = createRoute({
  method: 'post',
  path: '/change-password',
  tags: ['auth'],
  request: { body: json(ChangePasswordRequest) },
  responses: {
    204: { description: 'password changed; other sessions and agent access revoked' },
    ...errors,
  },
});
const setPasswordRoute = createRoute({
  method: 'post',
  path: '/password',
  tags: ['auth'],
  request: { body: json(SetPasswordRequest.extend({ reauthentication: Reauthentication })) },
  responses: { 204: { description: 'password added' }, ...errors },
});
const listSessionsRoute = createRoute({
  method: 'get',
  path: '/sessions',
  tags: ['auth'],
  responses: {
    200: { description: 'active sessions, without tokens', ...json(ActiveSessionList) },
    ...errors,
  },
});
const revokeSessionRoute = createRoute({
  method: 'post',
  path: '/sessions/{sessionId}/revoke',
  tags: ['auth'],
  request: { params: z.object({ sessionId: z.string().min(1).max(128) }) },
  responses: { 204: { description: 'session signed out' }, ...errors },
});
const revokeOtherSessionsRoute = createRoute({
  method: 'post',
  path: '/sessions/revoke-others',
  tags: ['auth'],
  responses: { 204: { description: 'every other session signed out' }, ...errors },
});
const signOutEverywhereRoute = createRoute({
  method: 'post',
  path: '/sign-out-everywhere',
  tags: ['auth'],
  request: { body: json(z.object({ reauthentication: Reauthentication })) },
  responses: {
    204: { description: 'every session, known device, live connection and agent token revoked' },
    ...errors,
  },
});
const revokeAgentAccessRoute = createRoute({
  method: 'post',
  path: '/agent-access/revoke',
  tags: ['auth'],
  responses: { 204: { description: 'every AI agent token and consent revoked' }, ...errors },
});
const linkSingleSignOnRoute = createRoute({
  method: 'post',
  path: '/single-sign-on/link',
  tags: ['auth'],
  request: { body: json(z.object({ reauthentication: Reauthentication })) },
  responses: {
    200: { description: 'identity provider address to navigate to', ...json(SingleSignOnRedirect) },
    ...errors,
  },
});
const unlinkSingleSignOnRoute = createRoute({
  method: 'post',
  path: '/single-sign-on/unlink',
  tags: ['auth'],
  request: { body: json(z.object({ reauthentication: Reauthentication })) },
  responses: {
    204: { description: 'single sign-on identity removed' },
    409: { description: 'it is the only way to sign in', ...json(ErrorEnvelope) },
    ...errors,
  },
});
const getSecuritySettingsRoute = createRoute({
  method: 'get',
  path: '/security-settings',
  tags: ['auth'],
  responses: {
    200: { description: 'sign-in protection settings', ...json(AuthSecuritySettings) },
    ...errors,
  },
});
const updateSecuritySettingsRoute = createRoute({
  method: 'patch',
  path: '/security-settings',
  tags: ['auth'],
  request: { body: json(UpdateAuthSecuritySettingsRequest) },
  responses: { 200: { description: 'settings saved', ...json(AuthSecuritySettings) }, ...errors },
});
const securityEventsRoute = createRoute({
  method: 'get',
  path: '/security-events',
  tags: ['auth'],
  request: {
    query: z.object({
      // Checked here rather than in the handler: a timestamp Postgres cannot cast or a non-uuid id would otherwise reach the query and fail as a 500.
      before: compositeCursor({
        separator: SECURITY_EVENT_CURSOR_SEPARATOR,
        allowBareTimestamp: false,
      })
        .max(128)
        .optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: {
    200: { description: 'security events, newest first', ...json(SecurityEventPage) },
    ...errors,
  },
});

/**
 * The caller as the limiter and audit trail see them.
 *
 * @param di - The container.
 * @param c - The request.
 * @param operatorId - The operator's user id, when known; a known-device mark is only honoured for them.
 * @returns Address, browser, and whether the browser carries a current known-device mark.
 */
const attemptOf = async (di: DI, c: Context<Env>, operatorId: string | null): Promise<Attempt> => {
  const headers = c.req.raw.headers;
  const { securityEpoch } = await di.security.settings.get();
  return {
    ipAddress: clientIpFromHeaders(headers),
    userAgent: headers.get('user-agent'),
    knownDevice: isKnownDevice(
      di.env.AUTH_SECRET,
      readKnownDevice(headers),
      operatorId,
      securityEpoch,
    ),
  };
};

/**
 * Runs a password check under the process's hashing capacity. Password hashing is deliberately slow, so an unbounded queue of checks would let a flood of attempts exhaust the CPU; an overflow becomes a recorded 429 instead of a queued hash.
 *
 * @param di - The container, for the capacity gate, the limit metric and the security event log.
 * @param attempt - The caller's address and browser, recorded when the check is refused.
 * @param fn - The work that hashes or verifies a password and produces the route's response.
 * @returns The response from `fn`, or a 429 when the process has no hashing capacity left.
 */
const underPasswordCapacity = async (
  di: DI,
  attempt: Attempt,
  fn: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await di.security.passwordChecks.run(fn);
  } catch (err) {
    if (!(err instanceof PasswordCheckOverloadedError)) throw err;
    di.security.metrics.limited.inc({ limit: 'password_check_capacity' });
    await di.security.events.record({
      event: 'password-check-overloaded',
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    return rateLimitedResponse(5000);
  }
};

/**
 * Adds a known-device mark to a sign-in response, so the next sign-in from this browser is judged under the known-device limits rather than the stricter unknown-device ones. The mark is re-issued on every successful sign-in so its lifetime slides.
 *
 * @param di - The container, for the signing secret and the current security epoch.
 * @param response - The successful sign-in response the cookie is appended to.
 * @param userId - The operator the mark is issued for; it is honoured only for that user.
 * @returns The same response, with a `Set-Cookie` for the mark when one was issued.
 */
const withKnownDevice = async (di: DI, response: Response, userId: string): Promise<Response> => {
  response.headers.append('set-cookie', await knownDeviceCookieFor(di, userId));
  return response;
};

/**
 * Reads Better Auth's error code from its response. Routes branch on the code (a wrong password versus any other refusal) because the HTTP status alone does not tell them apart.
 *
 * @param response - A Better Auth response, read through a clone so the original body stays usable.
 * @returns The `code` field of the JSON body, or null when the body is not JSON or carries no string code.
 */
const errorCodeOf = async (response: Response): Promise<string | null> => {
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
};

/**
 * Reads the identity provider address from a Better Auth single sign-on start or link response. Redirects are disabled on those calls so this route can add its own parameters and keep the body shape it documents.
 *
 * @param response - Better Auth's start or link response, read through a clone.
 * @returns The address to send the browser to, or null when the response carries none.
 */
const redirectUrlOf = async (response: Response): Promise<string | null> => {
  const started = (await response
    .clone()
    .json()
    .catch(() => null)) as { url?: unknown } | null;
  return typeof started?.url === 'string' ? started.url : null;
};

/**
 * The session token from Better Auth's change-password response. With `revokeOtherSessions` Better Auth deletes every session and issues one replacement; its token is the only handle that names that exact row.
 *
 * @param response - Better Auth's successful change-password response.
 * @returns The replacement session's token, or null when the body carries none.
 */
const sessionTokenOf = async (response: Response): Promise<string | null> => {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { token?: unknown } | null;
  return typeof body?.token === 'string' ? body.token : null;
};

/**
 * Looks up the caller's session through Better Auth, so routes can tell the current session apart from the others they list or revoke.
 *
 * @param di - The container, for the Better Auth instance.
 * @param c - The request whose session cookie is resolved.
 * @returns The session's row id and its owner's user id, or null when the request carries no valid session.
 */
const currentSession = async (
  di: DI,
  c: Context<Env>,
): Promise<{ id: string; userId: string } | null> => {
  const result = await di.auth.api.getSession({ headers: c.req.raw.headers });
  return result ? { id: result.session.id, userId: result.user.id } : null;
};

/**
 * Runs a re-authentication check and turns a refusal by a limit into the 429 the client understands. Any other failure, including a wrong password, is rethrown for the error handler.
 *
 * @param fn - The re-authentication check; resolving means the proof was accepted.
 * @returns Null when the proof was accepted, or a 429 response when a limit refused it.
 */
const guardReauthentication = async (fn: () => Promise<void>): Promise<Response | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof ReauthenticationLimitedError)
      return rateLimitedResponse(err.refusal.retryAfterMs);
    throw err;
  }
};

export const authRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  const { security } = di;
  const reauthenticate = (c: Context<Env>, proof: Reauthentication, attempt: Attempt) =>
    guardReauthentication(() =>
      requireReauthentication(di.db, di.auth, security, c.req.raw.headers, proof, attempt),
    );

  // Every answer here is personal and short-lived; no browser or proxy cache may keep one.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });

  // No sign-in concept in the live demo: every route that creates, ends or changes a session or credential is off. The read routes stay open so the demo's pages render.
  for (const path of [
    '/sign-up',
    '/sign-up/*',
    '/sign-in/*',
    '/sign-out',
    '/single-sign-on/*',
    '/change-password',
    '/password',
    '/sessions',
    '/sessions/*',
    '/sign-out-everywhere',
    '/agent-access/*',
    '/security-settings',
    '/security-events',
    '/callback/*',
  ]) {
    app.use(path, requireNotDemo(di));
  }

  app.openapi(onboardingStatusRoute, async (c) => {
    const masterExists = (await repo.authIdentity.countUsers(di.db)) >= 1;
    const sso = security.singleSignOn;
    return c.json(
      {
        masterExists,
        demoMode: di.env.LIVE_DEMO,
        passwordSignIn: security.passwordSignIn,
        singleSignOn:
          sso === null
            ? null
            : { buttonLabel: sso.buttonLabel, available: security.singleSignOnAvailable },
        passwordSignInForced: security.passwordSignInForced,
      },
      200,
    );
  });

  // Creates the operator with a password. Open only while no operator exists; Better Auth's own user-create hook and the database index refuse a second one even if this check were bypassed.
  app.openapi(signUpRoute, async (c) => {
    if (!security.passwordSignIn)
      throw new HttpError('NOT_FOUND', 'password sign-in is turned off');
    if ((await repo.authIdentity.countUsers(di.db)) >= 1) {
      throw new HttpError('ONBOARDING_CLOSED', 'public sign-up is closed');
    }
    const body = c.req.valid('json');
    const attempt = await attemptOf(di, c, null);
    const refusal = await security.protection.checkPasswordAttempt(attempt, body.email);
    if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs) as never;
    const context: AuthRequestContext = {
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
      method: 'onboarding',
    };
    const atSign = body.email.indexOf('@');
    return (await underPasswordCapacity(di, attempt, async () => {
      const response = await runWithAuthRequestContext(context, () =>
        di.auth.api.signUpEmail({
          body: {
            email: body.email,
            password: body.password,
            name: body.displayName ?? body.email.slice(0, atSign),
          },
          headers: c.req.raw.headers,
          asResponse: true,
        }),
      );
      if (response.status >= 400) {
        // A lost race with a concurrent sign-up lands here: the create hook or the unique index refused the second user.
        if ((await repo.authIdentity.countUsers(di.db)) >= 1)
          throw new HttpError('ONBOARDING_CLOSED', 'public sign-up is closed');
        throw new HttpError(
          'VALIDATION_FAILED',
          'could not create the operator',
          await errorCodeOf(response),
        );
      }
      const out = withCookiesFrom(response, { ok: true }, 200);
      return context.createdSession ? withKnownDevice(di, out, context.createdSession.userId) : out;
    })) as never;
  });

  // Password sign-in. The session goes to the browser as an httpOnly cookie only; Better Auth's response body, which also carries the session token, is replaced.
  app.openapi(signInRoute, async (c) => {
    if (!security.passwordSignIn)
      throw new HttpError('NOT_FOUND', 'password sign-in is turned off');
    const body = c.req.valid('json');
    const operator = await repo.authIdentity.findSoleUser(di.db);
    const attempt = await attemptOf(di, c, operator?.id ?? null);
    const refusal = await security.protection.checkPasswordAttempt(attempt, body.email);
    if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs) as never;
    const context: AuthRequestContext = {
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
      method: 'password',
    };
    return (await underPasswordCapacity(di, attempt, async () => {
      const response = await runWithAuthRequestContext(context, () =>
        di.auth.api.signInEmail({
          body: { email: body.email, password: body.password },
          headers: c.req.raw.headers,
          asResponse: true,
        }),
      );
      if (response.status >= 400 || context.createdSession === undefined) {
        const code = await errorCodeOf(response);
        const emailMatched =
          operator !== null && normalizeEmail(body.email) === normalizeEmail(operator.email);
        const reason: SecurityEventReason =
          code === 'INVALID_EMAIL_OR_PASSWORD' ? 'invalid_credentials' : 'session_refused';
        if (reason === 'invalid_credentials')
          await security.protection.recordPasswordFailure(attempt, body.email);
        await security.events.record({
          event: 'sign-in-failed',
          method: 'password',
          reason,
          ipAddress: attempt.ipAddress,
          userAgent: attempt.userAgent,
          emailMatched,
        });
        throw new HttpError('UNAUTHENTICATED', 'The email or password is not correct.');
      }
      return withKnownDevice(
        di,
        withCookiesFrom(response, { ok: true }, 200),
        context.createdSession.userId,
      );
    })) as never;
  });

  app.openapi(signOutRoute, async (c) => {
    const session = await currentSession(di, c);
    const response = await di.auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    if (session !== null) {
      await publishSessionRevocation(di, { sessionIds: [session.id] });
      await security.events.record({
        event: 'sign-out',
        actor: 'user',
        ipAddress: clientIpFromHeaders(c.req.raw.headers),
        userAgent: c.req.header('user-agent') ?? null,
      });
    }
    return withCookiesFrom(response, { ok: true }, 200) as never;
  });

  // Starts single sign-on (sign-in, onboarding, or re-authentication). Better Auth's own start endpoint stays unexposed; this route fixes the provider, keeps redirects inside the app, and decides whether a new operator may be created.
  app.openapi(singleSignOnStartRoute, async (c) => {
    if (!singleSignOnReady(di)) throw new HttpError('NOT_FOUND', 'single sign-on is not available');
    const body = c.req.valid('json');
    const attempt = await attemptOf(di, c, null);
    const refusal = await security.protection.checkAddressLimit('single_sign_on_starts', attempt);
    if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs) as never;
    const noOperator = (await repo.authIdentity.countUsers(di.db)) === 0;
    const response = await di.auth.api.signInSocial({
      body: {
        provider: SINGLE_SIGN_ON_PROVIDER_ID,
        callbackURL: sameOriginPath(body.returnTo),
        errorCallbackURL: body.reauthenticate ? '/settings/security' : '/login',
        disableRedirect: true,
        ...(noOperator ? { requestSignUp: true } : {}),
        // The signed agent-authorization request the sign-in page was opened with. Better Auth verifies its signature and resumes the authorization once the callback creates the session.
        ...(body.pendingAuthorization !== undefined
          ? { oauth_query: body.pendingAuthorization.replace(/^\?/, '') }
          : {}),
      } as never,
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const startedUrl = await redirectUrlOf(response);
    if (response.status >= 400 || startedUrl === null) {
      throw new HttpError(
        'UPSTREAM_FAILED',
        'could not start single sign-on',
        await errorCodeOf(response),
      );
    }
    const target = new URL(startedUrl);
    if (body.reauthenticate) {
      // Ask the provider to authenticate the person now, not reuse its own session; the ID token's auth_time then proves it.
      target.searchParams.set('prompt', 'login');
      target.searchParams.set('max_age', '0');
    }
    await security.events.record({
      event: 'single-sign-on-started',
      method: 'singleSignOn',
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    return withCookiesFrom(response, { url: target.toString() }, 200) as never;
  });

  app.use('/session', requireUser());
  app.openapi(sessionRoute, async (c) => {
    const session = await di.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) throw new HttpError('UNAUTHENTICATED', 'no session');
    const [providers, singleSignOnEmail] = await Promise.all([
      repo.authIdentity.listSignInProviders(di.db, session.user.id),
      repo.authIdentity.findSingleSignOnEmail(di.db, session.user.id),
    ]);
    return c.json(
      {
        userId: session.user.id,
        email: session.user.email,
        displayName: session.user.name ?? null,
        hasPassword: providers.includes('credential'),
        singleSignOnLinked: providers.includes(SINGLE_SIGN_ON_PROVIDER_ID),
        singleSignOnEmail,
      },
      200,
    );
  });

  app.use('/change-password', requireUser());
  app.openapi(changePasswordRoute, async (c) => {
    // With password sign-in off the stored password proves nothing, and a change signs out every other session and every agent, so a stolen session plus an old password must not be able to trigger it.
    if (!security.passwordSignIn)
      throw new HttpError('NOT_FOUND', 'password sign-in is turned off');
    const body = c.req.valid('json');
    const userId = c.get('userId') as UserId;
    const operator = await repo.authIdentity.findSoleUser(di.db);
    const attempt = await attemptOf(di, c, operator?.id ?? null);
    const refusal = await security.protection.checkPasswordAttempt(attempt, operator?.email ?? '');
    if (refusal !== null) return rateLimitedResponse(refusal.retryAfterMs) as never;
    const current = await currentSession(di, c);
    const response = await underPasswordCapacity(di, attempt, async () => {
      // Every other session is signed out: a password change is what the operator does when they suspect someone else has one. Better Auth deletes all sessions and issues this browser a new one, whose cookie is forwarded.
      return di.auth.api.changePassword({
        body: {
          currentPassword: body.oldPassword,
          newPassword: body.newPassword,
          revokeOtherSessions: true,
        },
        headers: c.req.raw.headers,
        asResponse: true,
      });
    });
    if (response.status === 429) return response as never;
    if (response.status >= 400) {
      const code = await errorCodeOf(response);
      if (code === 'INVALID_PASSWORD') {
        await security.protection.recordPasswordFailure(attempt, operator?.email ?? '');
        await security.events.record({
          event: 'reauthentication-failed',
          actor: 'user',
          method: 'password',
          reason: 'invalid_credentials',
          ipAddress: attempt.ipAddress,
          userAgent: attempt.userAgent,
        });
        throw new HttpError('INVALID_PASSWORD', 'old password does not match');
      }
      throw new HttpError('VALIDATION_FAILED', 'could not change the password', code);
    }
    const replacementToken = await sessionTokenOf(response);
    // A password change is what the operator does when they suspect an intruder, so it revokes like sign-out-everywhere does: the raised epoch retires every known-device mark and any session Better Auth did not delete, and agent tokens go because a password change alone leaves them working. The one replacement session Better Auth just issued this browser is moved onto the new epoch in the same transaction, so the operator stays signed in.
    const restamped = await di.db.transaction(async (tx) => {
      const epoch = await repo.authSecuritySettings.bumpSecurityEpoch(tx);
      await repo.authIdentity.revokeAgentAccess(tx, userId, new Date());
      return replacementToken === null
        ? false
        : repo.authIdentity.setSessionEpochByToken(tx, userId, replacementToken, epoch);
    });
    // Not a refusal: the password is already changed and everything is revoked; this browser is simply signed out on its next request.
    if (!restamped) di.logger.warn({ userId }, 'change_password_session_not_restamped');
    security.settings.invalidate();
    if (current !== null) await publishSessionRevocation(di, { exceptSessionIds: [], userId });
    await security.events.record({
      event: 'change-password',
      actor: 'user',
      method: 'password',
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    return withCookiesFrom(response, null, 204) as never;
  });

  app.use('/password', requireUser());
  app.openapi(setPasswordRoute, async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId') as UserId;
    const attempt = await attemptOf(di, c, userId);
    const refused = await reauthenticate(c, body.reauthentication, attempt);
    if (refused !== null) return refused as never;
    const providers = await repo.authIdentity.listSignInProviders(di.db, userId);
    if (providers.includes('credential'))
      throw new HttpError('CONFLICT', 'a password is already set; change it instead');
    await di.auth.api.setPassword({
      body: { newPassword: body.newPassword },
      headers: c.req.raw.headers,
    });
    await security.events.record({
      event: 'password-set',
      actor: 'user',
      method: body.reauthentication.method,
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    return c.body(null, 204);
  });

  app.use('/sessions', requireUser());
  app.use('/sessions/*', requireUser());
  app.openapi(listSessionsRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const current = await currentSession(di, c);
    const rows = await repo.authIdentity.listSessions(di.db, userId);
    return c.json(
      {
        sessions: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          lastActiveAt: r.updatedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          ipAddress: r.ipAddress,
          userAgent: r.userAgent,
          current: r.id === current?.id,
        })),
      },
      200,
    );
  });

  app.openapi(revokeSessionRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const { sessionId } = c.req.valid('param');
    if (!(await repo.authIdentity.deleteSession(di.db, userId, sessionId)))
      throw new HttpError('NOT_FOUND', 'session');
    await publishSessionRevocation(di, { sessionIds: [sessionId] });
    await security.events.record({
      event: 'session-revoked',
      actor: 'user',
      ipAddress: clientIpFromHeaders(c.req.raw.headers),
      userAgent: c.req.header('user-agent') ?? null,
    });
    return c.body(null, 204);
  });

  app.openapi(revokeOtherSessionsRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const current = await currentSession(di, c);
    const keptSessionIds = current === null ? [] : [current.id];
    const count = await repo.authIdentity.deleteSessionsExcept(di.db, userId, keptSessionIds);
    await publishSessionRevocation(di, { userId, exceptSessionIds: keptSessionIds });
    await security.events.record({
      event: 'sessions-revoked-others',
      actor: 'user',
      ipAddress: clientIpFromHeaders(c.req.raw.headers),
      userAgent: c.req.header('user-agent') ?? null,
      detail: { sessions: count },
    });
    return c.body(null, 204);
  });

  // The strongest revocation: every session including this one, every known-device mark (through the epoch), every open live connection, and every AI agent token. It is what the operator does after "I did not sign in just now".
  app.use('/sign-out-everywhere', requireUser());
  app.openapi(signOutEverywhereRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const body = c.req.valid('json');
    const attempt = await attemptOf(di, c, userId);
    const refused = await reauthenticate(c, body.reauthentication, attempt);
    if (refused !== null) return refused as never;
    await di.db.transaction(async (tx) => {
      await repo.authSecuritySettings.bumpSecurityEpoch(tx);
      await repo.authIdentity.deleteAllSessions(tx, userId);
      await repo.authIdentity.revokeAgentAccess(tx, userId, new Date());
    });
    security.settings.invalidate();
    await publishSessionRevocation(di, { userId, exceptSessionIds: [] });
    await security.events.record({
      event: 'signed-out-everywhere',
      actor: 'user',
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    return c.body(null, 204);
  });

  app.use('/agent-access/*', requireUser());
  app.openapi(revokeAgentAccessRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const removed = await repo.authIdentity.revokeAgentAccess(di.db, userId, new Date());
    security.settings.invalidate();
    await security.events.record({
      event: 'agent-access-revoked',
      actor: 'user',
      ipAddress: clientIpFromHeaders(c.req.raw.headers),
      userAgent: c.req.header('user-agent') ?? null,
      detail: { ...removed },
    });
    return c.body(null, 204);
  });

  app.use('/single-sign-on/link', requireUser());
  app.openapi(linkSingleSignOnRoute, async (c) => {
    if (!singleSignOnReady(di)) throw new HttpError('NOT_FOUND', 'single sign-on is not available');
    const userId = c.get('userId') as UserId;
    const body = c.req.valid('json');
    const attempt = await attemptOf(di, c, userId);
    const refused = await reauthenticate(c, body.reauthentication, attempt);
    if (refused !== null) return refused as never;
    const context: AuthRequestContext = {
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
      method: 'singleSignOn',
    };
    const response = await runWithAuthRequestContext(
      context,
      () =>
        di.auth.api.linkSocialAccount({
          body: {
            provider: SINGLE_SIGN_ON_PROVIDER_ID,
            callbackURL: '/settings/security?linked=1',
            errorCallbackURL: '/settings/security',
            disableRedirect: true,
          },
          headers: c.req.raw.headers,
          asResponse: true,
        }) as Promise<Response>,
    );
    const startedUrl = await redirectUrlOf(response);
    if (response.status >= 400 || startedUrl === null) {
      throw new HttpError(
        'UPSTREAM_FAILED',
        'could not start linking',
        await errorCodeOf(response),
      );
    }
    return withCookiesFrom(response, { url: startedUrl }, 200) as never;
  });

  app.use('/single-sign-on/unlink', requireUser());
  app.openapi(unlinkSingleSignOnRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const body = c.req.valid('json');
    const attempt = await attemptOf(di, c, userId);
    const providers = await repo.authIdentity.listSignInProviders(di.db, userId);
    // Unlinking must leave a way in: password sign-in has to be on for this deployment AND the operator has to have a password.
    if (!security.passwordSignIn || !providers.includes('credential')) {
      throw new HttpError(
        'CONFLICT',
        'Single sign-on is your only way to sign in. Set a password and turn password sign-in on first.',
      );
    }
    const refused = await reauthenticate(c, body.reauthentication, attempt);
    if (refused !== null) return refused as never;
    const removed = await repo.authIdentity.deleteSingleSignOnIdentities(di.db, userId);
    if (removed === 0) throw new HttpError('NOT_FOUND', 'no single sign-on identity is linked');
    await security.events.record({
      event: 'single-sign-on-unlinked',
      actor: 'user',
      method: body.reauthentication.method,
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
    });
    return c.body(null, 204);
  });

  app.use('/security-settings', requireUser());
  app.openapi(getSecuritySettingsRoute, async (c) =>
    c.json((await security.settings.get()).settings, 200),
  );

  app.openapi(updateSecuritySettingsRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const body = c.req.valid('json');
    const attempt = await attemptOf(di, c, userId);
    const refused = await reauthenticate(c, body.reauthentication, attempt);
    if (refused !== null) return refused as never;
    const before = (await security.settings.get()).settings;
    await repo.authSecuritySettings.setSettings(di.db, body.settings);
    security.settings.invalidate();
    const changed: Record<string, string> = {};
    for (const key of Object.keys(body.settings) as (keyof typeof body.settings)[]) {
      const was = JSON.stringify(before[key]);
      const now = JSON.stringify(body.settings[key]);
      if (was !== now) changed[key] = `${was} -> ${now}`.slice(0, 200);
    }
    await security.events.record({
      event: 'security-settings-changed',
      actor: 'user',
      method: body.reauthentication.method,
      ipAddress: attempt.ipAddress,
      userAgent: attempt.userAgent,
      detail: changed,
    });
    return c.json(body.settings, 200);
  });

  app.use('/security-events', requireUser());
  app.openapi(securityEventsRoute, async (c) => {
    const userId = c.get('userId') as UserId;
    const { before, limit } = c.req.valid('query');
    let cursor: { createdAt: string; id: string } | null = null;
    if (before !== undefined) {
      const { timestamp, id } = splitCompositeCursor(before, SECURITY_EVENT_CURSOR_SEPARATOR);
      cursor = { createdAt: timestamp, id };
    }
    const rows = await repo.auditLogs.listSecurityForOperator(di.db, userId, limit + 1, cursor);
    const page = rows.slice(0, limit);
    const events = page.flatMap((r) => {
      const payload = (r.payload ?? {}) as {
        method?: unknown;
        reason?: unknown;
        count?: unknown;
        detail?: unknown;
      };
      const parsed = SecurityEventRow.safeParse({
        id: r.id,
        event: r.event,
        method: typeof payload.method === 'string' ? payload.method : 'none',
        reason: typeof payload.reason === 'string' ? payload.reason : 'none',
        ipAddress: r.ip,
        userAgent: r.userAgent,
        count: typeof payload.count === 'number' ? payload.count : 1,
        detail: typeof payload.detail === 'object' && payload.detail !== null ? payload.detail : {},
        createdAt: r.createdAt.toISOString(),
      });
      // A row written by an older release with an event name no longer in the catalogue is skipped rather than failing the page.
      return parsed.success ? [parsed.data] : [];
    });
    const last = page.at(-1);
    return c.json(
      {
        events,
        nextBefore:
          rows.length > limit && last
            ? `${last.cursorToken}${SECURITY_EVENT_CURSOR_SEPARATOR}${last.id}`
            : null,
      },
      200,
    );
  });

  // Everything not claimed above: the few Better Auth endpoints a third party must call directly, under their limits, and 404 for the rest.
  app.all('/*', authGateway(di));

  return app;
};
