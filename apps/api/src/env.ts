import { z } from 'zod';

import { booleanEnvFlag, parseEnvOrThrow, sharedEnvFields, type PgSslMode } from '@app/core/env';

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  /**
   * Admin HTTP port that exposes /healthz, /readyz, /metrics. Separate from the
   * public api port so scrape latency cannot starve it; the operator's
   * HEALTHCHECK and Prometheus scrape target this port.
   */
  ADMIN_PORT: number;
  /**
   * Interface the admin server binds. Defaults to `127.0.0.1` so the
   * unauthenticated admin endpoints stay off the LAN under compose (scrapers
   * use in-container DNS). k8s sets `0.0.0.0` because the kubelet's httpGet
   * probes hit the pod IP, not loopback; restrict the exposed port with a
   * default-deny ingress NetworkPolicy (a Service is not a firewall, and pod
   * IPs are reachable cluster-wide by default).
   */
  ADMIN_HOST: string;
  /**
   * Allowlist of browser origins permitted for CORS, Better Auth CSRF
   * (`trustedOrigins`), and the WebSocket upgrade. Parsed from a comma-separated
   * `WEB_ORIGIN` env value (each entry trimmed, blanks dropped) so the SPA can
   * be served on more than one origin (e.g. localhost plus a LAN IP). Every
   * origin is matched exactly — credentialed CORS forbids a `*` wildcard.
   */
  WEB_ORIGIN: string[];
  DATABASE_URL: string;
  REDIS_URL: string;
  AUTH_SECRET: string;
  /** libpq sslmode passed to pg_dump / pg_restore in the backup route. */
  PGSSLMODE: PgSslMode;
  /**
   * Directory the worker writes scheduled `backup-<epochMillis>.dump` files to.
   * The backup-config status route reads it to list recent dumps; a missing
   * directory (no backup has run yet) reports an empty list, not an error.
   */
  BACKUP_DIR: string;
  /** Build SHA injected by the Docker build-arg; surfaced on `/status`. */
  GIT_SHA: string;
  /**
   * Directory of the built SPA (`apps/web/dist`) the api serves same-origin,
   * having absorbed the retired nginx `web` service. When the directory is
   * absent the api serves no SPA — dev (Vite serves it on :5173), tests, or an
   * api behind a CDN. The default is repo-relative; the container image sets it
   * to the path the build copies the SPA to.
   */
  WEB_DIST_DIR: string;
  /**
   * Public "Live demo" mode. When true, the api injects the sole demo operator id for every anonymous request (no login), locks credential, notifier, backup/restore, account-creation, account-rename/delete, retention-change, diagnosis-start, fee-reconciliation, and archive-backfill routes behind `requireNotDemo`, and refuses to boot if any account is live. Trading remains interactive on Binance testnet. A separate deployment concern; the operator's real instance always leaves this false. See `docs/architecture/auth.md`.
   */
  LIVE_DEMO: boolean;
  /**
   * Whether the authenticated MCP control plane is mounted at all. Off mounts no `/api/mcp` route and publishes no protected-resource metadata, so an operator who has not opted in has no agent surface to secure rather than a guarded one to trust.
   */
  MCP_ENABLED: boolean;
  /**
   * Canonical RFC 8707 / RFC 9728 resource identifier for the MCP endpoint, for example `https://bot.example.com/api/mcp`. Access tokens are audience-bound to this exact string, so it must be the URL agents actually reach rather than an internal address. Must be `https` unless it points at a loopback host, and must carry no query, fragment or userinfo. Required when `MCP_ENABLED` is true; ignored otherwise.
   */
  MCP_RESOURCE_URL?: string | undefined;
  /** Whether the email and password form is accepted. Off makes password sign-in and password sign-up refuse, and hides the form. */
  PASSWORD_SIGN_IN_ENABLED: boolean;
  /** Whether "Sign in with single sign-on" (OpenID Connect, for example Auth0) is offered. */
  SINGLE_SIGN_ON_ENABLED: boolean;
  /** The identity provider's issuer, for example `https://tenant.auth0.com/`. Must equal the `issuer` its discovery document publishes. */
  SINGLE_SIGN_ON_ISSUER_URL?: string | undefined;
  SINGLE_SIGN_ON_CLIENT_ID?: string | undefined;
  SINGLE_SIGN_ON_CLIENT_SECRET?: string | undefined;
  /** Text on the sign-in button. */
  SINGLE_SIGN_ON_BUTTON_LABEL: string;
  /** The public origin the app is reached at, for example `https://bot.example.com`. Single sign-on redirect addresses are built from it, never from request headers. */
  PUBLIC_BASE_URL?: string | undefined;
}

/**
 * Treats an empty string as unset. Compose passes `${NAME:-}` through as `""` when the operator left the variable out of `.env`, and without this an optional URL would fail boot on a value nobody wrote.
 *
 * @param schema - The optional schema that applies when a value is present.
 * @returns The same schema, reached only for a non-empty value.
 */
const unsetWhenEmpty = <T extends z.ZodType>(schema: T): z.ZodPreprocess<T> =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

/** Parses a value zod already accepted as a URL, yielding null when the WHATWG parser disagrees so the predicates below fail closed instead of treating an unparseable string as unconstrained. */
const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** Loopback per RFC 6761 and RFC 4291. `URL.hostname` keeps the brackets on an IPv6 literal, and the whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/** True when the transport carrying this resource's tokens and metadata cannot be read off the wire: `https` anywhere, or `http` whose bytes never leave the machine. */
const isSecureResourceOrigin = (value: string): boolean => {
  const url = parseUrl(value);
  if (url === null) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
};

/** True when the value is usable as an RFC 8707 resource identifier: no query, no fragment, no embedded credentials. */
const isBareResourceIdentifier = (value: string): boolean => {
  const url = parseUrl(value);
  if (url === null) return false;
  return url.search === '' && url.hash === '' && url.username === '' && url.password === '';
};

const EnvSchema = z
  .object({
    ...sharedEnvFields,
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    ADMIN_PORT: z.coerce.number().int().positive().default(9100),
    ADMIN_HOST: z.string().min(1).default('127.0.0.1'),
    WEB_ORIGIN: z
      .string()
      .min(1)
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .refine((origins) => origins.length > 0, {
        message: 'WEB_ORIGIN must list at least one origin',
      })
      // Reject `*`: Better Auth treats a `*` entry in trustedOrigins as a CSRF
      // wildcard, while CORS and the WS check match literally — so a wildcard
      // would silently loosen only the auth gate. Keep all three exact.
      .refine((origins) => origins.every((o) => !o.includes('*')), {
        message: 'WEB_ORIGIN entries must be exact origins; wildcards (*) are not supported',
      }),
    AUTH_SECRET: z.string().min(32),
    WEB_DIST_DIR: z.string().default('apps/web/dist'),
    LIVE_DEMO: booleanEnvFlag(),
    MCP_ENABLED: booleanEnvFlag(),
    // Trailing slashes are trimmed because the audience check is an exact string compare: a token minted for `…/mcp` and a metadata document advertising `…/mcp/` would never match, and the failure reads as an unexplained 401 rather than a typo.
    MCP_RESOURCE_URL: z
      .string()
      .trim()
      .url()
      // Zod's `url()` accepts any WHATWG-parseable URL, `ftp:` and plaintext `http:` included. This value is both the OAuth resource identifier and, via `authBaseUrlOption`, the Better Auth `baseURL`, so an `http` value would serve the issuer, the JWKS document and every authorization endpoint in the clear on a host that keeps Binance API keys in plaintext. The exemption keys on the HOST rather than on `NODE_ENV` because what makes plaintext acceptable is that the bytes never leave the machine: under a mode gate a real deployment that forgot `NODE_ENV=production` would silently get plaintext, and a developer running `NODE_ENV=production` locally would lose loopback.
      .refine(isSecureResourceOrigin, {
        message:
          'MCP_RESOURCE_URL must be an https URL; http is only allowed for a loopback host (localhost, 127.0.0.0/8, [::1])',
      })
      // The resource identifier is compared as an exact string and is republished verbatim to unauthenticated callers in the protected-resource metadata. A query or fragment makes the audience check hinge on punctuation the operator has to reproduce byte-for-byte in every client, and userinfo would put a credential into that public document.
      .refine(isBareResourceIdentifier, {
        message: 'MCP_RESOURCE_URL must carry no query string, fragment or embedded credentials',
      })
      .transform((u) => u.replace(/\/+$/, ''))
      .optional(),
    // Parsed strictly because the default is on: a loose parser turns a typo such as `yes` into "off", and the only symptom is a missing form.
    PASSWORD_SIGN_IN_ENABLED: z
      .enum(['0', '1', 'true', 'false'])
      .default('1')
      .transform((v) => v === '1' || v === 'true'),
    SINGLE_SIGN_ON_ENABLED: booleanEnvFlag(),
    // Kept exactly as written (trailing slash included): it is compared byte-for-byte with the `iss` claim, and Auth0 issuers end in a slash.
    SINGLE_SIGN_ON_ISSUER_URL: unsetWhenEmpty(
      z
        .string()
        .trim()
        .url()
        .refine(isSecureResourceOrigin, {
          message:
            'SINGLE_SIGN_ON_ISSUER_URL must be an https URL; http is only allowed for a loopback host',
        })
        .optional(),
    ),
    SINGLE_SIGN_ON_CLIENT_ID: unsetWhenEmpty(z.string().trim().min(1).optional()),
    SINGLE_SIGN_ON_CLIENT_SECRET: unsetWhenEmpty(z.string().min(1).optional()),
    SINGLE_SIGN_ON_BUTTON_LABEL: z.string().trim().min(1).max(40).default('Single sign-on'),
    PUBLIC_BASE_URL: unsetWhenEmpty(
      z
        .string()
        .trim()
        .url()
        .refine(isSecureResourceOrigin, {
          message: 'PUBLIC_BASE_URL must be an https URL; http is only allowed for a loopback host',
        })
        .refine((v) => parseUrl(v)?.origin === v.replace(/\/+$/, ''), {
          message:
            'PUBLIC_BASE_URL must be an origin only (scheme, host and port), with no path, query or credentials',
        })
        .transform((u) => u.replace(/\/+$/, ''))
        .optional(),
    ),
  })
  // The api boots two listeners (public on PORT, admin/healthz on ADMIN_PORT).
  // A collision would crash the second bind; surface the conflict at env-parse
  // time so the operator sees a clear message rather than EADDRINUSE.
  .refine((env) => env.PORT !== env.ADMIN_PORT, {
    message: 'PORT and ADMIN_PORT must differ',
    path: ['ADMIN_PORT'],
  })
  // Booting the MCP plane without a resource identifier would mint tokens bound to the server's guessed base URL, which is the one value an operator behind a proxy will get wrong, and the symptom is a 401 that names nothing.
  .refine((env) => !env.MCP_ENABLED || env.MCP_RESOURCE_URL !== undefined, {
    message: 'MCP_RESOURCE_URL is required when MCP_ENABLED is true',
    path: ['MCP_RESOURCE_URL'],
  })
  // The kill switch is documented as removing the MCP surface on a demo box, and only a boot refusal makes that true. The in-route 403 covers `/api/mcp` alone: with both flags on, `mountMcpRoutes` still publishes the discovery documents at the origin root and `createAuth` still stands up the whole OAuth authorization server (`/api/auth/oauth2/*`, `/api/auth/jwks`) on a box whose premise is that every anonymous request carries an injected operator identity. Refuse the combination here so the surface never exists; the in-route 403 stays as defence in depth.
  .refine((env) => !(env.MCP_ENABLED && env.LIVE_DEMO), {
    message:
      'MCP_ENABLED and LIVE_DEMO cannot both be true: the live demo injects the sole operator id for every anonymous request, so mounting the MCP control plane would publish an OAuth authorization server and its discovery documents in front of an identity no caller has to prove. Set one of them to 0.',
    path: ['MCP_ENABLED'],
  })
  .refine(
    (env) =>
      !env.SINGLE_SIGN_ON_ENABLED ||
      (env.SINGLE_SIGN_ON_ISSUER_URL !== undefined &&
        env.SINGLE_SIGN_ON_CLIENT_ID !== undefined &&
        env.SINGLE_SIGN_ON_CLIENT_SECRET !== undefined &&
        env.PUBLIC_BASE_URL !== undefined),
    {
      message:
        'SINGLE_SIGN_ON_ISSUER_URL, SINGLE_SIGN_ON_CLIENT_ID, SINGLE_SIGN_ON_CLIENT_SECRET and PUBLIC_BASE_URL are required when SINGLE_SIGN_ON_ENABLED is true',
      path: ['SINGLE_SIGN_ON_ENABLED'],
    },
  )
  // With neither method on nobody can sign in, and the only way back is a redeploy. The live demo has no sign-in at all, so it is exempt.
  .refine((env) => env.LIVE_DEMO || env.PASSWORD_SIGN_IN_ENABLED || env.SINGLE_SIGN_ON_ENABLED, {
    message: 'At least one of PASSWORD_SIGN_IN_ENABLED or SINGLE_SIGN_ON_ENABLED must be true',
    path: ['PASSWORD_SIGN_IN_ENABLED'],
  })
  // The demo injects an operator for anonymous callers; a single sign-on callback there would mint a real session on a box whose premise is that nobody signs in.
  .refine((env) => !(env.SINGLE_SIGN_ON_ENABLED && env.LIVE_DEMO), {
    message: 'SINGLE_SIGN_ON_ENABLED and LIVE_DEMO cannot both be true',
    path: ['SINGLE_SIGN_ON_ENABLED'],
  })
  // Better Auth publishes one origin for both the agent authorization server and the single sign-on redirect; two different values would sign tokens under one issuer and verify them under another.
  .refine(
    (env) =>
      env.PUBLIC_BASE_URL === undefined ||
      env.MCP_RESOURCE_URL === undefined ||
      parseUrl(env.MCP_RESOURCE_URL)?.origin === env.PUBLIC_BASE_URL,
    {
      message: 'PUBLIC_BASE_URL must be the same origin as MCP_RESOURCE_URL',
      path: ['PUBLIC_BASE_URL'],
    },
  );

export const loadEnv = (raw: NodeJS.ProcessEnv = process.env): Env =>
  parseEnvOrThrow(EnvSchema, raw, 'api');

export const publicListenerHostname = (raw: NodeJS.ProcessEnv = process.env): string | undefined =>
  raw['NODE_ENV'] === 'test' && raw['APP_E2E'] === '1' ? '127.0.0.1' : undefined;
