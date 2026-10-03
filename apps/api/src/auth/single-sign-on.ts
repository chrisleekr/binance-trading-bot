/** Single sign-on configuration, present only when it is enabled in the environment. */
export interface SingleSignOnConfig {
  /** Issuer exactly as configured; compared byte-for-byte with the discovery document and the ID token's `iss`. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly buttonLabel: string;
}

/** Outcome of checking the identity provider before registering it. */
export type DiscoveryResult =
  | { readonly ok: true; readonly discoveryUrl: string }
  | { readonly ok: false; readonly reason: 'unreachable' | 'issuer_mismatch' | 'incomplete' };

/** How long boot waits for the identity provider. Better Auth's own discovery fetch has no timeout, and every request waits for it, so this bound is what keeps an unreachable provider from hanging the whole API. */
export const DISCOVERY_TIMEOUT_MS = 5000;

/**
 * The discovery document address for an issuer, per OpenID Connect Discovery 1.0 section 4: the issuer with any trailing slash removed, followed by `/.well-known/openid-configuration`.
 *
 * @param issuer - The configured issuer.
 * @returns The discovery URL.
 */
export const discoveryUrlFor = (issuer: string): string => {
  // A scan rather than `/\/+$/`, which backtracks quadratically on a string holding many slashes that are not at the end.
  let end = issuer.length;
  while (end > 0 && issuer[end - 1] === '/') end -= 1;
  return `${issuer.slice(0, end)}/.well-known/openid-configuration`;
};

/**
 * Fetches and checks the identity provider's discovery document with a hard timeout.
 *
 * The provider is registered with Better Auth only when this passes. Beyond reachability it requires the published `issuer` to equal the configured one exactly (OpenID Connect Discovery 1.0 section 4.3 requires the same), and requires the endpoints and signing keys that ID-token verification depends on. A provider that fails is left unregistered and the app runs without single sign-on rather than hanging or trusting a document it cannot verify.
 *
 * @param issuer - The configured issuer.
 * @param fetchImpl - Fetch, injectable for tests.
 * @param timeoutMs - Upper bound on the whole request.
 * @returns Whether the provider can be registered, and why not when it cannot.
 */
export const checkDiscovery = async (
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<DiscoveryResult> => {
  const discoveryUrl = discoveryUrlFor(issuer);
  let body: unknown;
  try {
    const res = await fetchImpl(discoveryUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) return { ok: false, reason: 'unreachable' };
    body = await res.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'incomplete' };
  const doc = body as Record<string, unknown>;
  if (doc['issuer'] !== issuer) return { ok: false, reason: 'issuer_mismatch' };
  const algs = doc['id_token_signing_alg_values_supported'];
  const complete =
    typeof doc['authorization_endpoint'] === 'string' &&
    typeof doc['token_endpoint'] === 'string' &&
    typeof doc['jwks_uri'] === 'string' &&
    Array.isArray(algs) &&
    algs.length > 0;
  if (!complete) return { ok: false, reason: 'incomplete' };
  return { ok: true, discoveryUrl };
};
