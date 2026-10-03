// /settings/security — how the operator signs in, who is signed in right now, which AI agents can act, how strict the sign-in limits are, and everything security-related that happened.
//
// Every change that weakens or moves a credential asks for proof first ("Confirm it's you"): the current password, or a single sign-on login made in the last five minutes. The server enforces this; the page only collects the proof once and reuses it for each action.

import {
  AuthSecuritySettings,
  SECURITY_EVENT_CATALOG,
  SIGN_IN_METHOD_LABEL,
  type ActiveSession,
  type Reauthentication,
  type SecurityEventRow,
} from '@app/contracts';
import {
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createRoute, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Page, PageHeader } from '@/shared/components/page';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Panel } from '@/shared/components/panel';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { useTimezone } from '@/shared/context/timezone-context';
import { ApiError, errorMessage } from '@/shared/lib/api';
import { formatInstant } from '@/shared/lib/format-time';
import { onboardingStatusQueryOptions } from '@/features/auth/api/auth';
import { startSingleSignOn } from '@/features/auth/api/auth-mutations';
import { signInErrorMessage } from '@/features/auth/routes/login';
import {
  fetchSecurityEvents,
  fetchSecuritySettings,
  fetchSession,
  fetchSessions,
  linkSingleSignOn,
  revokeAgentAccess,
  revokeOtherSessions,
  revokeSession,
  securityQueryKeys,
  setPassword,
  signOutEverywhere,
  unlinkSingleSignOn,
  updateSecuritySettings,
} from '@/features/account/api/security';
import { settingsRoute } from '@/features/account/routes/settings';

const SecuritySearch = z.object({
  // Set by the server when a single sign-on link or confirmation was refused. Only ever used as a lookup key into a fixed set of messages, so a crafted link cannot put its own text on this page.
  error: z.string().max(64).optional().catch(undefined),
  // Set by the server after the identity provider account was linked.
  linked: z.literal(1).optional().catch(undefined),
  // Set by this page as the return address of "Sign in again with single sign-on".
  confirmed: z.literal(1).optional().catch(undefined),
});
type SecuritySearch = z.infer<typeof SecuritySearch>;

/**
 * The outcome of a trip to the identity provider, read from the address it returned to. Without it the operator comes back from a refused link to an unchanged page and no hint of why.
 *
 * @param search - The validated query this page was opened with.
 * @returns The banner to show, or null when the page was opened normally.
 */
const returnBannerOf = (
  search: SecuritySearch,
): { readonly kind: 'ok' | 'err'; readonly message: string } | null => {
  if (search.error !== undefined) return { kind: 'err', message: signInErrorMessage(search.error) };
  if (search.linked === 1)
    return {
      kind: 'ok',
      message: 'Single sign-on is linked. You can now sign in with your identity provider.',
    };
  if (search.confirmed === 1)
    return {
      kind: 'ok',
      message: 'You confirmed it is you. Changes on this page will not ask again for five minutes.',
    };
  return null;
};

/** Collects the proof once; each action asks for it and gets null (with a prompt) when it is missing. */
interface Proof {
  readonly get: () => Reauthentication | null;
  /** Points the operator at "Confirm it's you" with this explanation. An action far down the page otherwise only raises a toast, and the button that fixes it is off screen. */
  readonly ask: (message: string) => void;
}

type Banner = (banner: ActionBannerState) => void;

/** Shown when an action needs proof and the operator has not given any yet. */
const CONFIRM_FIRST = 'Confirm it is you first, at the top of this page.';

/**
 * Reports a failed action. A refused confirmation is also shown beside "Confirm it's you", since the fix (the password, or a fresh single sign-on) is there and not next to the action.
 *
 * @param setBanner - Raises the toast for this action.
 * @param err - What the action threw.
 * @param proof - The page's proof, told when the server refused it; omitted for actions that need none.
 */
const fail = (setBanner: Banner, err: unknown, proof?: Proof): void => {
  const refusedProof =
    err instanceof ApiError &&
    (err.code === 'REAUTHENTICATION_REQUIRED' || err.code === 'INVALID_PASSWORD');
  if (refusedProof && proof !== undefined) {
    setBanner({ kind: 'err', message: err.message });
    proof.ask(err.message);
    return;
  }
  setBanner({ kind: 'err', message: errorMessage(err) });
};

/**
 * Tells the operator to confirm first, both as a toast and beside the confirmation panel.
 *
 * @param setBanner - Raises the toast for this action.
 * @param proof - The page's proof, which scrolls the confirmation panel into view.
 */
const confirmFirst = (setBanner: Banner, proof: Proof): void => {
  setBanner({ kind: 'err', message: CONFIRM_FIRST });
  proof.ask(CONFIRM_FIRST);
};

/**
 * Refetches the activity list after an action on this page. Every action records an event, a refused one included (a wrong confirmation password is recorded as a failed re-authentication), so without this the list shown beside the action stays stale until the page is reloaded.
 *
 * @param queryClient - The client holding the activity query.
 */
const refreshActivity = (queryClient: QueryClient): void => {
  void queryClient.invalidateQueries({ queryKey: securityQueryKeys.events });
};

function ConfirmPanel({
  passwordUsable,
  singleSignOnReady,
  password,
  onPassword,
  prompt,
}: {
  readonly passwordUsable: boolean;
  readonly singleSignOnReady: boolean;
  readonly password: string;
  readonly onPassword: (value: string) => void;
  /** Why an action just asked for confirmation, with a counter so the same message scrolls the panel into view again; null until one does. */
  readonly prompt: { readonly message: string; readonly count: number } | null;
}): React.JSX.Element {
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prompt !== null) panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [prompt]);
  const reauthenticate = async (): Promise<void> => {
    try {
      const { url } = await startSingleSignOn({
        reauthenticate: true,
        returnTo: '/settings/security?confirmed=1',
      });
      window.location.href = url;
    } catch (err) {
      fail(setBanner, err);
    }
  };
  return (
    <div ref={panelRef} className="scroll-mt-4">
      <Panel
        title="Confirm it's you"
        description="Changes on this page that could let someone else in ask for proof that you are at the keyboard, not someone using a browser you left signed in."
      >
        <div className="space-y-3">
          {prompt !== null && (
            <Alert variant="danger" data-testid="security-confirm-prompt" aria-live="assertive">
              <AlertDescription>{prompt.message}</AlertDescription>
            </Alert>
          )}
          {passwordUsable ? (
            <div className="space-y-1">
              <Label htmlFor="security-confirm-password">Current password</Label>
              <Input
                id="security-confirm-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => onPassword(e.target.value)}
                className="w-full sm:w-72"
              />
            </div>
          ) : (
            <p className="text-sm text-muted-fg">
              Confirm by signing in again with single sign-on. The confirmation lasts five minutes.
            </p>
          )}
          {singleSignOnReady && (
            <Button
              variant="outline"
              className="w-full sm:w-72"
              onClick={() => void reauthenticate()}
            >
              Sign in again with single sign-on
            </Button>
          )}
          <ActionBanner banner={banner} />
        </div>
      </Panel>
    </div>
  );
}

function MethodsPanel({ proof }: { readonly proof: Proof }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: securityQueryKeys.session,
    queryFn: fetchSession,
  });
  const { data: status } = useQuery(onboardingStatusQueryOptions);
  const [newPassword, setNewPassword] = useState('');
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [busy, setBusy] = useState(false);
  const sso = status?.singleSignOn ?? null;
  const run = async (
    action: (reauth: Reauthentication) => Promise<unknown>,
    ok: string,
  ): Promise<void> => {
    const reauth = proof.get();
    if (reauth === null) {
      confirmFirst(setBanner, proof);
      return;
    }
    setBusy(true);
    try {
      await action(reauth);
      setBanner({ kind: 'ok', message: ok });
      await queryClient.invalidateQueries({ queryKey: securityQueryKeys.session });
    } catch (err) {
      fail(setBanner, err, proof);
    } finally {
      setBusy(false);
      refreshActivity(queryClient);
    }
  };
  return (
    <Panel
      title="Sign-in methods"
      description="The ways into this app. Keep at least one you can always use."
    >
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-fg">Password</dt>
          <dd data-testid="security-method-password">
            {session?.hasPassword ? 'Set' : 'Not set'}
            {status?.passwordSignIn === false
              ? ' (password sign-in is turned off on the server)'
              : ''}
          </dd>
        </div>
        <div>
          <dt className="text-muted-fg">Single sign-on</dt>
          <dd data-testid="security-method-sso">
            {sso === null
              ? 'Not configured on the server'
              : session?.singleSignOnLinked
                ? session.singleSignOnEmail !== null
                  ? `Linked as ${session.singleSignOnEmail}`
                  : 'Linked'
                : 'Not linked'}
          </dd>
        </div>
      </dl>
      <div className="mt-4 space-y-3">
        {session !== undefined && !session.hasPassword && (
          <div className="space-y-2">
            <Label htmlFor="security-new-password">Add a password (at least 12 characters)</Label>
            <Input
              id="security-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full sm:w-72"
            />
            <Button
              disabled={busy || newPassword.length < 12}
              className="w-full sm:w-72"
              onClick={() => void run((r) => setPassword(newPassword, r), 'Password added.')}
            >
              Add password
            </Button>
          </div>
        )}
        {sso !== null && sso.available && session !== undefined && !session.singleSignOnLinked && (
          <Button
            variant="outline"
            disabled={busy}
            className="w-full sm:w-72"
            onClick={() =>
              void run(async (r) => {
                const { url } = await linkSingleSignOn(r);
                window.location.href = url;
              }, 'Opening your identity provider…')
            }
          >
            Link single sign-on
          </Button>
        )}
        {session?.singleSignOnLinked === true && (
          <Button
            variant="outline"
            disabled={busy || !session.hasPassword || status?.passwordSignIn === false}
            className="w-full sm:w-72"
            onClick={() => void run(unlinkSingleSignOn, 'Single sign-on unlinked.')}
          >
            Unlink single sign-on
          </Button>
        )}
      </div>
      <ActionBanner banner={banner} />
    </Panel>
  );
}

function SessionRow({
  session,
  onRevoke,
  busy,
}: {
  readonly session: ActiveSession;
  readonly onRevoke: (id: string) => void;
  readonly busy: boolean;
}): React.JSX.Element {
  const timeZone = useTimezone();
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className="font-medium text-fg">
          {session.ipAddress ?? 'Unknown address'}
          {session.current ? ' · this browser' : ''}
        </p>
        <p className="truncate text-muted-fg">{session.userAgent ?? 'Unknown browser'}</p>
        <p className="text-muted-fg">
          Signed in {formatInstant(session.createdAt, timeZone)} · last active{' '}
          {formatInstant(session.lastActiveAt, timeZone)}
        </p>
      </div>
      {!session.current && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onRevoke(session.id)}>
          Sign out
        </Button>
      )}
    </li>
  );
}

function SessionsPanel({ proof }: { readonly proof: Proof }): React.JSX.Element {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data } = useQuery({ queryKey: securityQueryKeys.sessions, queryFn: fetchSessions });
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      setBanner({ kind: 'ok', message: ok });
      await queryClient.invalidateQueries({ queryKey: securityQueryKeys.sessions });
    } catch (err) {
      fail(setBanner, err);
    } finally {
      setBusy(false);
      refreshActivity(queryClient);
    }
  };
  const everywhere = async (): Promise<void> => {
    const reauth = proof.get();
    if (reauth === null) {
      confirmFirst(setBanner, proof);
      return;
    }
    setBusy(true);
    try {
      await signOutEverywhere(reauth);
      await router.navigate({ to: '/login' });
    } catch (err) {
      fail(setBanner, err, proof);
      setBusy(false);
      refreshActivity(queryClient);
    }
  };
  return (
    <Panel
      title="Signed-in browsers"
      description="Every browser signed in as you. Sign out any you do not recognise, then change your password."
    >
      <ul className="space-y-2">
        {(data?.sessions ?? []).map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            busy={busy}
            onRevoke={(id) => void act(() => revokeSession(id), 'Browser signed out.')}
          />
        ))}
      </ul>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void act(revokeOtherSessions, 'Every other browser signed out.')}
        >
          Sign out other browsers
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void everywhere()}>
          Sign out everywhere
        </Button>
      </div>
      <p className="mt-2 text-sm text-muted-fg">
        Sign out everywhere also signs out this browser, forgets every recognised device, and ends
        every AI agent&apos;s access.
      </p>
      <ActionBanner banner={banner} />
    </Panel>
  );
}

function AgentPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [busy, setBusy] = useState(false);
  const revoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await revokeAgentAccess();
      setBanner({
        kind: 'ok',
        message:
          'Every AI agent has lost access. An agent you still use will ask you to approve it again.',
      });
    } catch (err) {
      fail(setBanner, err);
    } finally {
      setBusy(false);
      refreshActivity(queryClient);
    }
  };
  return (
    <Panel
      title="AI agent access"
      description="AI agents (such as Claude Code) that you approved can read and trade through this app. Revoking ends every approval at once, including tokens they already hold."
    >
      <Button
        variant="destructive"
        className="w-full sm:w-72"
        disabled={busy}
        onClick={() => void revoke()}
      >
        Revoke all agent access
      </Button>
      <ActionBanner banner={banner} />
    </Panel>
  );
}

/** One editable number: where it lives in the settings document, and what it means in plain words. */
interface LimitField {
  readonly path:
    readonly [keyof AuthSecuritySettings] | readonly [keyof AuthSecuritySettings, string];
  readonly label: string;
  readonly unit: string;
}

const LIMIT_GROUPS: readonly {
  readonly title: string;
  readonly gloss: string;
  readonly fields: readonly LimitField[];
}[] = [
  {
    title: 'Password attempts from one address',
    gloss:
      'How many passwords one internet address may try before it has to wait. An address that goes over is blocked, and each repeat within a day doubles the block.',
    fields: [
      { path: ['signInAttemptsPerIpAddress', 'maximumAttempts'], label: 'Attempts', unit: 'tries' },
      { path: ['signInAttemptsPerIpAddress', 'periodSeconds'], label: 'Per', unit: 'seconds' },
      { path: ['ipAddressBlock', 'initialBlockSeconds'], label: 'First block', unit: 'seconds' },
      { path: ['ipAddressBlock', 'maximumBlockSeconds'], label: 'Longest block', unit: 'seconds' },
    ],
  },
  {
    title: 'Password attempts against your email',
    gloss:
      'Limits guessing your password from many addresses. After too many wrong passwords, password sign-in is locked for a while, except on a browser that signed in successfully before.',
    fields: [
      { path: ['signInAttemptsPerEmail', 'maximumAttempts'], label: 'Attempts', unit: 'tries' },
      { path: ['signInAttemptsPerEmail', 'periodSeconds'], label: 'Per', unit: 'seconds' },
      {
        path: ['accountLockout', 'failedAttemptsBeforeLockout'],
        label: 'Wrong passwords before lock',
        unit: 'tries',
      },
      { path: ['accountLockout', 'failurePeriodSeconds'], label: 'Counted over', unit: 'seconds' },
      { path: ['accountLockout', 'lockoutSeconds'], label: 'Lock for', unit: 'seconds' },
    ],
  },
  {
    title: 'Whole-site slow-down',
    gloss:
      'If many wrong passwords arrive from anywhere, every unrecognised browser is slowed to one try per period until it calms down.',
    fields: [
      {
        path: ['siteWideFailedSignIns', 'maximumFailures'],
        label: 'Wrong passwords',
        unit: 'tries',
      },
      { path: ['siteWideFailedSignIns', 'periodSeconds'], label: 'Per', unit: 'seconds' },
    ],
  },
  {
    title: 'Request floods',
    gloss:
      'Caps how fast one address may call the app, checked before any real work so a flood cannot slow trading.',
    fields: [
      {
        path: ['anonymousApiRequestsPerIpAddressPerMinute'],
        label: 'Signed-out requests',
        unit: 'per minute',
      },
      {
        path: ['apiRequestsPerIpAddressPerMinute'],
        label: 'Signed-in requests',
        unit: 'per minute',
      },
      {
        path: ['otherAuthRequestsPerIpAddress', 'maximumRequests'],
        label: 'Other sign-in requests',
        unit: 'requests',
      },
      { path: ['otherAuthRequestsPerIpAddress', 'periodSeconds'], label: 'Per', unit: 'seconds' },
      { path: ['singleSignOnStartsPerMinute'], label: 'Single sign-on starts', unit: 'per minute' },
      { path: ['concurrentPasswordChecks'], label: 'Password checks at once', unit: 'checks' },
    ],
  },
  {
    title: 'Sessions',
    gloss: 'How long a signed-in browser stays signed in.',
    fields: [
      { path: ['sessionIdleTimeoutHours'], label: 'Sign out after inactivity', unit: 'hours' },
      {
        path: ['sessionAbsoluteLifetimeHours'],
        label: 'Sign out after sign-in, however active',
        unit: 'hours',
      },
      { path: ['knownDeviceLifetimeDays'], label: 'Remember a browser for', unit: 'days' },
    ],
  },
  {
    title: 'Security history',
    gloss:
      'How long the activity list below is kept. Never less than a year, so evidence outlives a break-in.',
    fields: [{ path: ['securityEventRetentionDays'], label: 'Keep for', unit: 'days' }],
  },
];

/**
 * The range the server accepts for a field, read from the shared contract so the form cannot drift from the server's own validation.
 *
 * @param path - Where the field lives in the settings document.
 * @returns The inclusive minimum and maximum.
 */
const boundsOf = (path: LimitField['path']): { min: number; max: number } => {
  type Node = z.ZodType & {
    shape?: Record<string, Node>;
    unwrap?: () => Node;
    minValue?: number | null;
    maxValue?: number | null;
  };
  let node = (AuthSecuritySettings as unknown as Node).shape?.[path[0]];
  if (path.length === 2) node = node?.unwrap?.().shape?.[path[1]];
  const leaf = node?.unwrap?.();
  return { min: leaf?.minValue ?? 0, max: leaf?.maxValue ?? 0 };
};

const readField = (settings: AuthSecuritySettings, path: LimitField['path']): number => {
  const top = settings[path[0]] as unknown;
  return (path.length === 2 ? (top as Record<string, number>)[path[1]] : top) as number;
};

const writeField = (
  settings: AuthSecuritySettings,
  path: LimitField['path'],
  value: number,
): AuthSecuritySettings => {
  if (path.length === 1) return { ...settings, [path[0]]: value };
  const group = settings[path[0]] as unknown as Record<string, number>;
  return { ...settings, [path[0]]: { ...group, [path[1]]: value } };
};

/**
 * Turns the first validation failure into a sentence naming the field, because the schema's own range message ("Too big: expected number to be <=10") does not say which of the twenty-odd inputs is wrong, and several share a label such as "Attempts".
 *
 * @param issue - The first issue from parsing the draft, or undefined when parsing produced none.
 * @returns The group and field with the range the server accepts, or the schema's message for a rule spanning two fields, which is already written for the operator.
 */
const describeLimitIssue = (issue: z.core.$ZodIssue | undefined): string => {
  if (issue === undefined) return 'Some values are outside the allowed range.';
  // A cross-field rule can point at one field (the session rule does), yet that field is within its own range.
  if (issue.code === 'custom') return issue.message;
  const key = issue.path.join('.');
  for (const group of LIMIT_GROUPS) {
    const field = group.fields.find((f) => f.path.join('.') === key);
    if (field === undefined) continue;
    const { min, max } = boundsOf(field.path);
    return `${group.title}, ${field.label.toLowerCase()}: enter a whole number from ${min} to ${max}.`;
  }
  return issue.message;
};

function LimitsPanel({ proof }: { readonly proof: Proof }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: securityQueryKeys.settings,
    queryFn: fetchSecuritySettings,
  });
  const [draft, setDraft] = useState<AuthSecuritySettings | null>(null);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [busy, setBusy] = useState(false);
  const current = draft ?? data;
  if (current === undefined)
    return (
      <Panel title="Sign-in limits">
        <LoadingRows />
      </Panel>
    );
  const save = async (): Promise<void> => {
    const reauth = proof.get();
    if (reauth === null) {
      confirmFirst(setBanner, proof);
      return;
    }
    const parsed = AuthSecuritySettings.safeParse(current);
    if (!parsed.success) {
      setBanner({ kind: 'err', message: describeLimitIssue(parsed.error.issues[0]) });
      return;
    }
    setBusy(true);
    try {
      await updateSecuritySettings(parsed.data, reauth);
      setDraft(null);
      setBanner({ kind: 'ok', message: 'Sign-in limits saved. They apply within half a minute.' });
      await queryClient.invalidateQueries({ queryKey: securityQueryKeys.settings });
    } catch (err) {
      fail(setBanner, err, proof);
    } finally {
      setBusy(false);
      refreshActivity(queryClient);
    }
  };
  return (
    <Panel
      title="Sign-in limits"
      description="Defaults are strict because only you sign in. Each value has a range the server enforces, so no setting can switch a protection off."
      collapsible
      defaultOpen={false}
    >
      <div className="space-y-6">
        {LIMIT_GROUPS.map((group) => (
          <fieldset key={group.title} className="space-y-3">
            <legend className="text-sm font-medium text-fg">{group.title}</legend>
            <p className="text-sm text-muted-fg">{group.gloss}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.fields.map((field) => {
                const id = `limit-${field.path.join('-')}`;
                const { min, max } = boundsOf(field.path);
                return (
                  <div key={id} className="space-y-1">
                    <Label htmlFor={id}>
                      {field.label} ({field.unit})
                    </Label>
                    <Input
                      id={id}
                      type="number"
                      inputMode="numeric"
                      min={min}
                      max={max}
                      value={readField(current, field.path)}
                      onChange={(e) =>
                        setDraft(writeField(current, field.path, Number(e.target.value)))
                      }
                    />
                    <p className="text-xs text-muted-fg">
                      Allowed {min} to {max}
                    </p>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        <Button
          disabled={busy || draft === null}
          className="w-full sm:w-56"
          onClick={() => void save()}
        >
          Save limits
        </Button>
      </div>
      <ActionBanner banner={banner} />
    </Panel>
  );
}

function EventRow({ row }: { readonly row: SecurityEventRow }): React.JSX.Element {
  const timeZone = useTimezone();
  const meta = SECURITY_EVENT_CATALOG[row.event];
  // A grouped row keeps the time and address of its first occurrence only; the repeats can come from other addresses, so both are labelled as the first rather than read as the source of every one.
  const grouped = row.count > 1;
  return (
    <li className="space-y-0.5 border-b border-border py-2 text-sm last:border-b-0">
      <p className={meta.notify === 'alert' ? 'font-medium text-fg' : 'text-fg'}>
        {meta.description}
        {grouped ? ` (${row.count} times)` : ''}
      </p>
      <p className="text-muted-fg">
        {grouped ? 'First ' : ''}
        {formatInstant(row.createdAt, timeZone)}
        {row.ipAddress ? ` · ${grouped ? 'first from ' : ''}${row.ipAddress}` : ''}
        {typeof row.detail['account'] === 'string' ? ` · as ${row.detail['account']}` : ''}
        {/* Without the method every sign-in reads the same, and an unexpected one is what this list exists to show. */}
        {row.method !== 'none' ? ` · via ${SIGN_IN_METHOD_LABEL[row.method]}` : ''}
        {row.reason !== 'none' ? ` · ${row.reason.replace(/_/g, ' ')}` : ''}
      </p>
    </li>
  );
}

function ActivityPanel(): React.JSX.Element {
  const events = useInfiniteQuery({
    queryKey: securityQueryKeys.events,
    queryFn: ({ pageParam }) => fetchSecurityEvents(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <Panel
      title="Security activity"
      description="Sign-ins, failed attempts, blocks, and every change to credentials and security settings. Repeated failures are grouped, with a count."
    >
      {rows.length === 0 && !events.isLoading ? (
        <p className="text-sm text-muted-fg">Nothing recorded yet.</p>
      ) : null}
      <ul data-testid="security-activity">
        {rows.map((row) => (
          <EventRow key={row.id} row={row} />
        ))}
      </ul>
      {events.hasNextPage && (
        <Button
          variant="outline"
          className="mt-3 w-full sm:w-56"
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          Show older
        </Button>
      )}
    </Panel>
  );
}

function SecurityPage(): React.JSX.Element {
  const search = useSearch({ from: securityRoute.id });
  const returnBanner = returnBannerOf(search);
  const { data: session } = useQuery({
    queryKey: securityQueryKeys.session,
    queryFn: fetchSession,
  });
  const { data: status } = useQuery(onboardingStatusQueryOptions);
  const [password, setPasswordInput] = useState('');
  const [prompt, setPrompt] = useState<{ message: string; count: number } | null>(null);
  // The server refuses a password as proof while password sign-in is switched off, so the field is only offered when it can work.
  const passwordUsable = (session?.hasPassword ?? true) && status?.passwordSignIn !== false;
  const singleSignOnReady =
    session?.singleSignOnLinked === true && status?.singleSignOn?.available === true;
  const proof: Proof = {
    get: () => {
      if (passwordUsable && password.length > 0) return { method: 'password', password };
      // A single sign-on proof is the session itself; the server checks it was made interactively in the last five minutes.
      if (!passwordUsable || singleSignOnReady) return { method: 'singleSignOn' };
      return null;
    },
    ask: (message) => setPrompt((prev) => ({ message, count: (prev?.count ?? 0) + 1 })),
  };
  return (
    <Page>
      <PageHeader title="Security" />
      {returnBanner !== null && (
        <Alert
          variant={returnBanner.kind === 'err' ? 'danger' : 'default'}
          data-testid="security-return-banner"
          aria-live={returnBanner.kind === 'err' ? 'assertive' : 'polite'}
        >
          <AlertDescription>{returnBanner.message}</AlertDescription>
        </Alert>
      )}
      <ConfirmPanel
        passwordUsable={passwordUsable}
        singleSignOnReady={singleSignOnReady}
        password={password}
        onPassword={setPasswordInput}
        prompt={prompt}
      />
      <MethodsPanel proof={proof} />
      <SessionsPanel proof={proof} />
      <AgentPanel />
      <LimitsPanel proof={proof} />
      <ActivityPanel />
    </Page>
  );
}

export const securityRoute = createRoute({
  staticData: { title: 'Security' },
  getParentRoute: () => settingsRoute,
  path: '/security',
  component: SecurityPage,
  validateSearch: (raw: Record<string, unknown>): SecuritySearch => SecuritySearch.parse(raw),
});
