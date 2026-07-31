import {
  ChangePasswordRequest,
  ErrorEnvelope,
  OnboardingStatus,
  SessionResponse,
  SignUpRequest,
} from '@app/contracts';
import { repo } from '@app/db';
import { createRoute } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { createApiHono, type ApiHono } from 'types.js';

const onboardingStatusRoute = createRoute({
  method: 'get',
  path: '/onboarding-status',
  tags: ['auth'],
  responses: {
    200: {
      description: 'onboarding status',
      content: { 'application/json': { schema: OnboardingStatus } },
    },
  },
});

const signUpRoute = createRoute({
  method: 'post',
  path: '/sign-up',
  tags: ['auth'],
  request: { body: { content: { 'application/json': { schema: SignUpRequest } } } },
  responses: {
    200: { description: 'master account created' },
    403: {
      description: 'ONBOARDING_CLOSED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const sessionRoute = createRoute({
  method: 'get',
  path: '/session',
  tags: ['auth'],
  responses: {
    200: { description: 'session', content: { 'application/json': { schema: SessionResponse } } },
    401: {
      description: 'no session',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const changePasswordRoute = createRoute({
  method: 'post',
  path: '/change-password',
  tags: ['auth'],
  request: {
    body: { content: { 'application/json': { schema: ChangePasswordRequest } } },
  },
  responses: {
    204: { description: 'password updated' },
    401: {
      description: 'INVALID_PASSWORD',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const authRouter = (di: DI): ApiHono => {
  const app = createApiHono();

  // Onboarding status: unauthenticated, no rate limit.
  app.openapi(onboardingStatusRoute, async (c) => {
    const masterExists = (await repo.users.count(di.db)) >= 1;
    return c.json({ masterExists, demoMode: di.env.LIVE_DEMO }, 200);
  });

  // Sign-up gate. Once a user exists, return 403 ONBOARDING_CLOSED. Otherwise
  // delegate to Better Auth's email signup. The post-onboarding hook in
  // auth.ts then inserts the matching domain `users` row.
  app.openapi(signUpRoute, async (c) => {
    const existing = await repo.users.count(di.db);
    if (existing >= 1) {
      throw new HttpError('ONBOARDING_CLOSED', 'public sign-up is closed');
    }
    const body = c.req.valid('json');
    // Better Auth's canonical email signup lives at /sign-up/email and its
    // body requires a non-empty `name`; the project contract exposes
    // `/sign-up` with `displayName` optional. Translate at the boundary so
    // the SPA contract stays project-shaped and Better Auth still owns the
    // session cookie. asResponse: true returns the Set-Cookie response
    // verbatim. The onboarding-complete audit row is written inside the BA
    // user.create after-hook (apps/api/src/auth.ts) together with the
    // domain users row, so no auditEvent is set here.
    const atSign = body.email.indexOf('@');
    return di.auth.api.signUpEmail({
      body: {
        email: body.email,
        password: body.password,
        // zod validates `email`, so `atSign > 0` and the local-part slice is
        // always non-empty — no extra fallback needed.
        name: body.displayName ?? body.email.slice(0, atSign),
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });
  });

  // Session: Better Auth tells us who's signed in. We expose a project-shaped
  // response so the frontend can rely on a stable contract independent of
  // Better Auth's internal shape.
  app.openapi(sessionRoute, async (c) => {
    const session = await di.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) throw new HttpError('UNAUTHENTICATED', 'no session');
    return c.json(
      {
        userId: session.user.id,
        email: session.user.email,
        displayName: session.user.name ?? null,
      },
      200,
    );
  });

  // No login concept in the live demo: the credential routes are off. `/sign-up/*`
  // covers Better Auth's native `/sign-up/email`, which the catch-all below would
  // otherwise expose past the onboarding-closed gate.
  app.use('/change-password', requireNotDemo(di));
  app.use('/sign-out', requireNotDemo(di));
  app.use('/sign-in/*', requireNotDemo(di));
  app.use('/sign-up/*', requireNotDemo(di));

  // Change password: authenticated; verifies oldPassword and updates. Session
  // is NOT invalidated. Audit-logged.
  app.use('/change-password', requireUser());
  app.openapi(changePasswordRoute, async (c) => {
    const body = c.req.valid('json');
    try {
      await di.auth.api.changePassword({
        body: {
          currentPassword: body.oldPassword,
          newPassword: body.newPassword,
          revokeOtherSessions: false,
        },
        headers: c.req.raw.headers,
      });
    } catch (err) {
      di.logger.warn({ err }, 'change_password_failed');
      throw new HttpError('INVALID_PASSWORD', 'old password does not match');
    }
    c.set('auditEvent', { event: 'change-password' });
    return new Response(null, { status: 204 });
  });

  // Mount Better Auth's catch-all (sign-in, sign-out, etc.) last so the
  // explicit routes above are matched first. Login throttle is mounted at
  // /api/auth/sign-in by app.ts.
  app.all('/*', async (c) => di.auth.handler(c.req.raw));

  return app;
};
