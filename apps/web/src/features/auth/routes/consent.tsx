import { createRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { t, type I18nKey } from '@/shared/lib/i18n';
import { rootRoute } from '@/app/__root';

// The authorization server signs the query it redirects here with, and identifies the covered parameters by repeating their names in `ba_param`. It then re-verifies that signature over exactly those parameters, so the decision has to carry back that subset and nothing else: a raw `location.search` may have collected extra parameters that were never signed, and the page's own validated search is the wrong source because it has already dropped `sig` and `ba_param`.
const SIGNATURE_PARAM = 'sig';
const SIGNED_NAMES_PARAM = 'ba_param';

/**
 * Rebuild the signed authorization query the consent endpoint expects.
 *
 * @param rawSearch - The untouched `location.search` this page was opened with.
 * @returns The signed subset as a query string, or null when the page was reached without a signed authorization request behind it and there is therefore nothing to approve.
 */
const signedOAuthQuery = (rawSearch: string): string | null => {
  const params = new URLSearchParams(rawSearch);
  if (!params.has(SIGNATURE_PARAM)) return null;
  const covered = new Set(params.getAll(SIGNED_NAMES_PARAM));
  if (covered.size === 0) return null;
  const signed = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === SIGNATURE_PARAM || key === SIGNED_NAMES_PARAM || covered.has(key)) {
      signed.append(key, value);
    }
  }
  return signed.toString();
};

/**
 * What the operator is shown about the request, read out of the signed subset only.
 *
 * Anyone can append a `client_name`, a second `client_id` or a milder `scope` to the link before sending it to the operator, and a parameter the signature never covered must not reach the operator as fact: what they read and what they approve have to be one source. The scope list matters most, since it is the line that says whether the grant can spend money. The authorization server signs every parameter it puts on this redirect, so a genuine request always carries its scopes inside the signed set.
 *
 * @param signedQuery - The output of `signedOAuthQuery`, never the raw page query.
 * @returns The requested scopes, the signed client id, and the client's self-asserted name, each empty or null when the signed set does not carry it.
 */
const signedRequestOf = (
  signedQuery: string,
): { requested: string[]; clientId: string | null; claimedName: string | null } => {
  const params = new URLSearchParams(signedQuery);
  return {
    requested: (params.get('scope') ?? '').split(' ').filter(Boolean),
    clientId: params.get('client_id'),
    claimedName: params.get('client_name'),
  };
};

/**
 * The origin of a client id, when it is the HTTPS metadata URL a CIMD client identifies itself by.
 *
 * This deployment accepts client-id metadata documents, so anyone on the internet can be a client without registering first and every descriptive field in that document is written by whoever is asking. The origin is the one part the authorization server actually resolved the metadata from, which makes it the only identity on this screen the operator can check.
 *
 * @param clientId - The `client_id` as the authorization server signed it.
 * @returns The scheme-and-host prefix, or null when the id is not a URL at all and therefore has no origin to show.
 */
const originOf = (clientId: string): string | null => {
  try {
    return new URL(clientId).origin;
  } catch {
    return null;
  }
};

/**
 * Plain-language copy for each scope the authorization server can request.
 *
 * The descriptions go through `t()` like the rest of the screen rather than sitting here as English literals. This is the last human checkpoint before an automated system can spend money, so an operator reading the page in another language must not find the buttons translated and the thing they are agreeing to not.
 */
const SCOPE_COPY: Readonly<Record<string, { title: I18nKey; body: I18nKey; danger: boolean }>> = {
  'mcp:read': {
    title: 'consent.scope.mcp_read.title',
    body: 'consent.scope.mcp_read.body',
    danger: false,
  },
  'mcp:trade': {
    title: 'consent.scope.mcp_trade.title',
    body: 'consent.scope.mcp_trade.body',
    danger: true,
  },
};

/**
 * Where the OAuth authorization server sends the operator to approve an AI agent.
 *
 * The decision on this page is the only thing standing between a stranger's MCP client and a trading surface, so it names the client and the two scopes in plain language rather than showing the raw scope strings. `mcp:trade` is deliberately rendered as a warning: an operator who approves it is handing an automated system the ability to spend their money, and that should not look the same as approving a read.
 *
 * The decision is posted as JSON rather than as a form, because the endpoint reads `accept` as a boolean and a form sends every field as a string.
 */
function ConsentPage() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<I18nKey | null>(null);
  const signedQuery = signedOAuthQuery(window.location.search);
  const { requested, clientId, claimedName } = signedRequestOf(signedQuery ?? '');
  const clientOrigin = clientId === null ? null : originOf(clientId);
  // The origin leads because it is checkable; the name is the client's own words about itself, so it is shown as a claim underneath rather than as the heading.
  const clientHeading = clientOrigin ?? clientId ?? t('consent.unknown_client');

  const decide = async (accept: boolean): Promise<void> => {
    // Read off `location` rather than the router: the signature covers repeated `ba_param` entries, and the router re-serialises a repeated key into a single JSON array, which no longer verifies. The validated `search` is wrong for the same reason plus one more, having already dropped the parameters its schema does not model.
    const oauthQuery = signedOAuthQuery(window.location.search);
    if (oauthQuery === null) {
      setError('consent.error.unsigned');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/oauth2/consent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Pins the JSON branch. The endpoint otherwise decides by sniffing whether the caller looks like a browser fetch, and on the other branch it answers with a real 302 that this code could not follow.
          accept: 'application/json',
        },
        // The session cookie is what proves who is approving; without it the endpoint cannot bind the decision to an operator.
        credentials: 'include',
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
      });
      // `url`, not the `redirect_uri` the endpoint's own OpenAPI metadata advertises: the implementation answers `{ redirect: true, url }`, and reading the documented name yields undefined against a real server.
      const body = (await res.json().catch(() => null)) as { url?: string } | null;
      // A denial is a successful decision too, and the server answers it with the redirect carrying `access_denied` back to the client. Following it either way is what closes the flow instead of stranding the agent waiting.
      if (!res.ok || !body?.url) {
        setError('consent.error.failed');
        setSubmitting(false);
        return;
      }
      window.location.href = body.url;
    } catch {
      setError('consent.error.failed');
      setSubmitting(false);
    }
  };

  // Without a signature there is no authorization request behind this page, so there is nothing to approve and no client to name. Rendering the full prompt anyway would put a trading-authority decision in front of the operator for a request that does not exist, and this screen must never look like a legitimate approval when it is not. `decide` keeps its own refusal because the query is re-read at click time and a history entry can be swapped under the page after this render.
  if (signedQuery === null) {
    return (
      <section className="mx-auto w-full max-w-md rounded-md border border-border-strong bg-bg-elevated p-6">
        <Alert variant="danger" data-testid="consent-error">
          <AlertDescription>{t('consent.error.unsigned')}</AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-md space-y-6 rounded-md border border-border-strong bg-bg-elevated p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-fg">{t('consent.title')}</h1>
        <p className="text-sm text-muted-fg">{t('consent.subtitle')}</p>
      </header>

      <Alert variant="default" data-testid="consent-client">
        <p className="text-xs text-muted-fg">{t('consent.client.from_label')}</p>
        {/* `break-all` because a metadata URL is one unbroken token and would otherwise push the card wider than a 375px phone. */}
        <AlertTitle className="text-base break-all">{clientHeading}</AlertTitle>
        <AlertDescription className="space-y-1">
          {clientOrigin === null ? null : <p className="break-all">{clientId}</p>}
          {claimedName === null ? null : (
            <p data-testid="consent-client-claim">
              {t('consent.client.claimed_name', { name: claimedName })}
            </p>
          )}
          <p className="text-muted-fg">{t('consent.client.address_hint')}</p>
        </AlertDescription>
      </Alert>

      <ul className="space-y-3" data-testid="consent-scopes">
        {requested.map((scope) => {
          const copy = SCOPE_COPY[scope];
          return (
            <li
              key={scope}
              className={`rounded-md border p-3 ${copy?.danger ? 'border-danger' : 'border-border-strong'}`}
            >
              <p className={`text-sm font-semibold ${copy?.danger ? 'text-danger' : 'text-fg'}`}>
                {copy ? t(copy.title) : scope}
              </p>
              <p className="text-sm text-muted-fg">{copy ? t(copy.body) : scope}</p>
            </li>
          );
        })}
      </ul>

      {error ? (
        <Alert variant="danger" data-testid="consent-error">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={submitting}
          onClick={() => void decide(false)}
        >
          {t('consent.deny')}
        </Button>
        <Button
          type="button"
          variant="primary"
          className="w-full"
          disabled={submitting}
          onClick={() => void decide(true)}
        >
          {t('consent.allow')}
        </Button>
      </div>
    </section>
  );
}

export const consentRoute = createRoute({
  staticData: { title: 'Authorize agent' },
  getParentRoute: () => rootRoute,
  path: '/consent',
  component: ConsentPage,
});
