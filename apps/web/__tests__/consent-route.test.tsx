// The consent screen is the last human checkpoint before an automated client can trade. Everything it has to get right is about what the operator READS before pressing Allow: which client is asking, what each scope actually permits, and which of the two can spend money.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { consentRoute } from '@/features/auth/routes/consent';
import { t } from '@/shared/lib/i18n';
import { rootRoute } from '@/app/__root';

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (
  initial: string,
  calls: { url: string; init?: RequestInit }[] = [],
  opts: { consentStatus?: number; consentBody?: unknown; consentRejects?: boolean } = {},
) => {
  // jsdom refuses a real navigation, and the assignment is the thing under test, so location is replaced with a plain recorder. `search` is served from here too, because the page reads the signed query off `location` rather than the router: the router collapses the repeated `ba_param` entries the signature covers into a single JSON array.
  const search = initial.includes('?') ? initial.slice(initial.indexOf('?')) : '';
  Object.defineProperty(window, 'location', { value: { href: '', search }, writable: true });
  // The root route resolves onboarding status before rendering a child. Seeded rather than fetched, because this suite is about what the consent screen renders and an unmocked fetch would make it about the shell instead.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      if (String(url) === '/api/auth/oauth2/consent') {
        if (opts.consentRejects) throw new TypeError('Failed to fetch');
        // `{ redirect, url }` is what the endpoint actually answers with, confirmed against a running server. Its own OpenAPI metadata advertises `redirect_uri`, and a fixture built from the documentation rather than the behaviour is how a page that cannot complete the flow still passes its tests.
        return new Response(
          JSON.stringify(
            opts.consentBody ?? { redirect: true, url: 'https://client.example/cb?code=xyz' },
          ),
          {
            status: opts.consentStatus ?? 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response(JSON.stringify({ masterExists: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  const router = createRouter({
    routeTree: rootRoute.addChildren([stub('/'), consentRoute]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* See onboarding-route.test.tsx for widening the strictly registered router. */}
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

// The parameters with no signature at all. Only ever useful to prove the page refuses it.
const CONSENT_URL =
  '/consent?client_id=https%3A%2F%2Fclient.example%2Fmeta.json&client_name=Some%20Agent&scope=mcp%3Aread%20mcp%3Atrade';

// What the authorization server actually redirects here with: the signature, the `ba_param` list naming every parameter it covers, and the covered parameters themselves. `noise` is carried alongside and is deliberately NOT named, so a page that posts the query back wholesale can be told apart from one that posts the signed subset.
const SIGNED_CONSENT_URL = `${CONSENT_URL}&sig=deadbeef&ba_param=sig&ba_param=ba_param&ba_param=client_id&ba_param=scope&noise=1`;

// The same redirect with `client_name` inside the signed set, which is the only way a name is anything more than a string someone appended to the link.
const SIGNED_NAMED_CONSENT_URL = `${SIGNED_CONSENT_URL}&ba_param=client_name`;

// A client whose metadata document calls it "Claude Desktop" while being served from an origin that has nothing to do with Anthropic. Both fields are signed, so this is not a tampered link: it is exactly what a stranger's own metadata document is allowed to say about itself under CIMD.
const MASQUERADE_CONSENT_URL =
  '/consent?client_id=https%3A%2F%2Fnot-anthropic.example%2Fagent%2Fmeta.json&client_name=Claude%20Desktop&scope=mcp%3Atrade' +
  '&sig=deadbeef&ba_param=sig&ba_param=ba_param&ba_param=client_id&ba_param=client_name&ba_param=scope';

const headingOf = (client: HTMLElement) => client.querySelector('h5')?.textContent ?? '';

describe('ConsentPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('leads with the origin the metadata was resolved from and shows the full identifier under it', async () => {
    setUp(SIGNED_NAMED_CONSENT_URL);
    const client = await screen.findByTestId('consent-client');
    // The heading is the one part of the identity that was not written by whoever is asking, so that is what the operator's eye lands on first.
    expect(headingOf(client)).toBe('https://client.example');
    expect(client).toHaveTextContent('https://client.example/meta.json');
  });

  it('shows the self-chosen name as a claim, never as the heading', async () => {
    setUp(SIGNED_NAMED_CONSENT_URL);
    const client = await screen.findByTestId('consent-client');
    expect(headingOf(client)).not.toContain('Some Agent');
    expect(screen.getByTestId('consent-client-claim')).toHaveTextContent(
      t('consent.client.claimed_name', { name: 'Some Agent' }),
    );
  });

  it('keeps the unrelated origin in front of a client that calls itself Claude Desktop', async () => {
    setUp(MASQUERADE_CONSENT_URL);
    const client = await screen.findByTestId('consent-client');
    // Any host on the internet can serve a metadata document naming itself after software the operator trusts. If that name were the heading, the operator would read "Claude Desktop" directly above the scope that spends real money.
    expect(headingOf(client)).toBe('https://not-anthropic.example');
    expect(headingOf(client)).not.toContain('Claude Desktop');
    expect(screen.getByTestId('consent-client-claim')).toHaveTextContent(
      t('consent.client.claimed_name', { name: 'Claude Desktop' }),
    );
  });

  it('ignores a client name the signature does not cover', async () => {
    // `client_name` is present in the link but absent from `ba_param`, so nobody vouched for it. The page posts the signed subset, and a name outside that subset must not reach the operator as fact either.
    setUp(SIGNED_CONSENT_URL);
    const client = await screen.findByTestId('consent-client');
    expect(client).not.toHaveTextContent('Some Agent');
    expect(headingOf(client)).toBe('https://client.example');
  });

  it('shows no scope the signature does not cover', async () => {
    // The scope list is the line that says whether the grant can spend money, so it has to come from the signed subset like the identity does. Here `scope` rides on the link but is missing from `ba_param`, which is only possible if someone added it after the authorization server signed the redirect. Reading it from the router would put a permission in front of the operator that nothing vouched for.
    setUp(
      '/consent?client_id=https%3A%2F%2Fclient.example%2Fmeta.json&scope=mcp%3Aread' +
        '&sig=deadbeef&ba_param=sig&ba_param=ba_param&ba_param=client_id',
    );
    const scopes = await screen.findByTestId('consent-scopes');
    expect(scopes.querySelectorAll('li')).toHaveLength(0);
    expect(scopes).not.toHaveTextContent(t('consent.scope.mcp_read.title'));
  });

  it('falls back to the raw identifier when the client id is not a URL', async () => {
    // A client registered the ordinary way carries an opaque id rather than a metadata URL, and there is no origin to lift out of it. Showing the id itself keeps the heading on something the server issued instead of promoting the name.
    setUp(
      '/consent?client_id=opaque-registered-id&client_name=Claude%20Desktop&scope=mcp%3Aread' +
        '&sig=deadbeef&ba_param=sig&ba_param=ba_param&ba_param=client_id&ba_param=client_name&ba_param=scope',
    );
    const client = await screen.findByTestId('consent-client');
    expect(headingOf(client)).toBe('opaque-registered-id');
  });

  it('renders without a name at all, since a metadata document need not carry one', async () => {
    setUp(
      '/consent?client_id=https%3A%2F%2Fclient.example%2Fmeta.json&scope=mcp%3Aread' +
        '&sig=deadbeef&ba_param=sig&ba_param=ba_param&ba_param=client_id&ba_param=scope',
    );
    const client = await screen.findByTestId('consent-client');
    expect(headingOf(client)).toBe('https://client.example');
    expect(screen.queryByTestId('consent-client-claim')).toBeNull();
  });

  it('explains each requested scope in the operator language, not as a scope string', async () => {
    setUp(SIGNED_CONSENT_URL);
    const scopes = await screen.findByTestId('consent-scopes');
    // Asserted against the i18n catalogue rather than retyped prose: a translation that drops one of these paragraphs leaves the operator approving a permission the page never described.
    expect(scopes).toHaveTextContent(t('consent.scope.mcp_read.title'));
    expect(scopes).toHaveTextContent(t('consent.scope.mcp_trade.title'));
    expect(scopes).toHaveTextContent(t('consent.scope.mcp_trade.body'));
    expect(scopes).not.toHaveTextContent('mcp:trade');
  });

  it('marks the trading scope as dangerous and the read scope as not', async () => {
    setUp(SIGNED_CONSENT_URL);
    const items = (await screen.findByTestId('consent-scopes')).querySelectorAll('li');
    expect(items).toHaveLength(2);
    const danger = [...items].filter((li) => li.className.includes('border-danger'));
    // Exactly one, not "at least one": if approving a read looked the same as approving the ability to spend money, the distinction the whole screen exists to draw would be invisible.
    expect(danger).toHaveLength(1);
    expect(danger[0]).toHaveTextContent(t('consent.scope.mcp_trade.title'));
  });

  it.each([
    ['consent.allow' as const, true],
    ['consent.deny' as const, false],
  ])(
    'posts %s as the signed decision and follows the redirect it is given',
    async (key, accept) => {
      const calls: { url: string; init?: RequestInit }[] = [];
      setUp(SIGNED_CONSENT_URL, calls);
      const button = await screen.findByRole('button', { name: t(key) });
      await userEvent.click(button);

      const posted = calls.find((c) => c.url === '/api/auth/oauth2/consent');
      expect(posted).toBeDefined();
      const body = JSON.parse(String(posted?.init?.body ?? '{}')) as {
        accept?: unknown;
        oauth_query?: string;
      };
      // A boolean, not the string a form would have sent: the endpoint parses `accept` with a boolean schema, so `"true"` is rejected and a denial that arrived as `"false"` would read as malformed rather than as a refusal.
      expect(body.accept).toBe(accept);
      // Exactly the signed subset. `sig` and the `ba_param` names that identify it must survive, and `noise` must not: the server re-verifies over the parameters `ba_param` lists, so a decision carrying anything else fails the signature it is supposed to prove.
      const sent = new URLSearchParams(body.oauth_query ?? '');
      expect(sent.get('sig')).toBe('deadbeef');
      expect(sent.getAll('ba_param').sort()).toEqual(['ba_param', 'client_id', 'scope', 'sig']);
      expect(sent.get('client_id')).toBe('https://client.example/meta.json');
      expect(sent.has('noise')).toBe(false);
      // The reply carries the URI rather than redirecting itself, so a page that ignored it would leave the operator staring at a decision they already made and the agent waiting forever.
      expect(window.location.href).toBe('https://client.example/cb?code=xyz');
    },
  );

  it('shows no decision at all when the page was opened without a signed authorization request', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    setUp(CONSENT_URL, calls);
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(
      t('consent.error.unsigned'),
    );
    // Asserted as absent, not as "clicking it fails". There is no request behind this page, so a screen that still offered Allow and Deny under a client name and a list of scopes would look exactly like a real approval for one that does not exist.
    expect(screen.queryByRole('button', { name: t('consent.allow') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('consent.deny') })).toBeNull();
    expect(screen.queryByTestId('consent-client')).toBeNull();
    expect(screen.queryByTestId('consent-scopes')).toBeNull();
    expect(calls.find((c) => c.url === '/api/auth/oauth2/consent')).toBeUndefined();
  });

  it('keeps the operator on the page and says so when the server refuses the decision', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    setUp(SIGNED_CONSENT_URL, calls, { consentStatus: 400 });
    await userEvent.click(await screen.findByRole('button', { name: t('consent.allow') }));
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(t('consent.error.failed'));
    // Navigating on a rejected decision would send the client a code the server never issued.
    expect(window.location.href).not.toContain('client.example/cb');
  });

  it('refuses a signature that names no covered parameters', async () => {
    // `sig` alone vouches for nothing: with no `ba_param` list the server has no parameter set to re-verify, so the client and scopes on the link are exactly as unsigned as if `sig` were absent, and offering a decision over them would look like a real approval.
    const calls: { url: string; init?: RequestInit }[] = [];
    setUp(`${CONSENT_URL}&sig=deadbeef`, calls);
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(
      t('consent.error.unsigned'),
    );
    expect(screen.queryByRole('button', { name: t('consent.allow') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('consent.deny') })).toBeNull();
  });

  it('stays on the page when the server accepts the decision but names no redirect', async () => {
    // A 200 without `url` is not a completed flow: navigating to `undefined` would strand the operator on a broken page while the agent waits for a code that never arrives.
    setUp(SIGNED_CONSENT_URL, [], { consentBody: { redirect: true } });
    await userEvent.click(await screen.findByRole('button', { name: t('consent.allow') }));
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(t('consent.error.failed'));
    expect(window.location.href).toBe('');
  });

  it('says the decision failed when the request never reaches the server', async () => {
    // A network failure rejects the fetch rather than answering, so it bypasses the status check entirely and needs its own path to the error.
    setUp(SIGNED_CONSENT_URL, [], { consentRejects: true });
    await userEvent.click(await screen.findByRole('button', { name: t('consent.allow') }));
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(t('consent.error.failed'));
    expect(window.location.href).toBe('');
  });

  it('falls back to the raw scope string for a scope it has no copy for', async () => {
    setUp(
      '/consent?scope=mcp%3Aread%20some%3Afuture&sig=deadbeef&ba_param=sig&ba_param=ba_param&ba_param=scope',
    );
    const scopes = await screen.findByTestId('consent-scopes');
    // Silently dropping an unknown scope would be the worst possible failure here: the operator would approve a permission the page never showed them.
    expect(scopes).toHaveTextContent('some:future');
    expect(scopes.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders nothing to approve when no scope was requested', async () => {
    setUp('/consent?sig=deadbeef&ba_param=sig&ba_param=ba_param');
    await screen.findByTestId('consent-scopes');
    expect(screen.getByTestId('consent-scopes').querySelectorAll('li')).toHaveLength(0);
    expect(screen.getByTestId('consent-client')).toHaveTextContent(t('consent.unknown_client'));
  });
});
