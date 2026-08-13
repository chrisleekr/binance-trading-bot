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
   * Public "Live demo" mode. When true, the api injects the sole demo operator
   * id for every anonymous request (no login), locks credential, notifier,
   * backup/restore, account-creation, retention-change, and diagnosis-start routes behind
   * `requireNotDemo`, and refuses to boot if any account is live. Trading
   * remains interactive on Binance testnet. A separate deployment concern; the
   * operator's real instance always leaves this false. See
   * `docs/architecture/auth.md`.
   */
  LIVE_DEMO: boolean;
}

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
  })
  // The api boots two listeners (public on PORT, admin/healthz on ADMIN_PORT).
  // A collision would crash the second bind; surface the conflict at env-parse
  // time so the operator sees a clear message rather than EADDRINUSE.
  .refine((env) => env.PORT !== env.ADMIN_PORT, {
    message: 'PORT and ADMIN_PORT must differ',
    path: ['ADMIN_PORT'],
  });

export const loadEnv = (raw: NodeJS.ProcessEnv = process.env): Env =>
  parseEnvOrThrow(EnvSchema, raw, 'api');

export const publicListenerHostname = (raw: NodeJS.ProcessEnv = process.env): string | undefined =>
  raw['NODE_ENV'] === 'test' && raw['APP_E2E'] === '1' ? '127.0.0.1' : undefined;
