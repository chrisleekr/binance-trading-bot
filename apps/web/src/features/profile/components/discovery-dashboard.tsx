// Discovery operations dashboard: the "is it working" scoreboard + exposure
// gauge for auto-discovered trading, plus the "can I stop it" pause control.
// Mobile-first: stat tiles reflow from 2 columns (375px) to 4 on desktop.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { DiscoveryConfigSchema, toConfigJsonSchema } from '@app/contracts';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Panel } from '@/shared/components/panel';
import { Switch } from '@/shared/components/ui/switch';
import { AutoForm } from '@/shared/forms';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatWinRate } from '@/shared/lib/format';
import { formatClock, formatInstant } from '@/shared/lib/format-time';
import { glossEntryBlocker } from '@/shared/lib/gloss-entry-blocker';
import {
  blocklistSymbol,
  discoveryDashboardQueryKey,
  discoveryDashboardQueryOptions,
  forceEject,
  patchDiscoveryConfig,
  pinSymbol,
  profileSymbolsQueryKey,
  profileSymbolsQueryOptions,
  unpinSymbol,
} from '@/features/profile/api/discovery';
import { profileDashboardQueryKey } from '@/features/profile/api/profile-dashboard';
import { wipeSymbol } from '@/features/symbol/api/symbol';

import type {
  DiscoveryActivityEntry,
  DiscoveryCandidate,
  DiscoveryDisposition,
  DiscoveryFilterName,
  DiscoveryHolding,
  DiscoveryUniverse as DiscoveryUniverseT,
  StoredDiscoveryConfig,
} from '@app/contracts';

const fmtAmount = (s: string): string => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(2) : s;
};
const fmtSigned = (s: string): string => {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
};
const toneClass = (s: string): string => (Number(s) >= 0 ? 'text-up' : 'text-down');

/** Humanise a scan period given in ms: 900000 -> "15 min", 3600000 -> "1 h". */
const fmtPeriod = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
};

function Tile({
  label,
  value,
  tone,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  /** Semantic colour utility for the value, e.g. `text-up` / `text-down`. */
  readonly tone?: string;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <span className="text-muted-fg text-xs">{label}</span>
      <span className={`font-mono text-lg font-semibold tabular-nums${tone ? ` ${tone}` : ''}`}>
        {value}
      </span>
    </div>
  );
}

const FILTER_LABEL: Record<DiscoveryFilterName, string> = {
  quote: 'quote asset',
  blacklist: 'blocklist',
  liquidity: 'liquidity',
  activity: 'coin activity',
  spread: 'spread',
  changeBand: '24h gain band',
  age: 'listing age',
  trend: 'trend',
};

export const DISPOSITION: Record<
  DiscoveryDisposition,
  { label: string; variant: 'default' | 'outline' }
> = {
  added: { label: 'added', variant: 'default' },
  kept: { label: 'held', variant: 'default' },
  'faded-held': { label: 'pending removal', variant: 'outline' },
  'faded-removed': { label: 'removing', variant: 'outline' },
  cooldown: { label: 'cooldown', variant: 'outline' },
  'slot-capped': { label: 'no slot', variant: 'outline' },
  'correlation-high': { label: 'too correlated', variant: 'outline' },
  'sibling-owns-base': { label: 'another profile', variant: 'outline' },
  'sibling-quotes-base': { label: 'another profile', variant: 'outline' },
  rejected: { label: 'out', variant: 'outline' },
};

/**
 * Plain-language "why didn't this coin qualify" line per failed filter, for a
 * non-expert operator (invariant #3). "trend" in particular is opaque jargon;
 * spell out what a confirmed uptrend means rather than naming the filter.
 */
const REJECT_REASON: Record<DiscoveryFilterName, string> = {
  quote: 'not quoted in the target asset',
  blacklist: 'on your blocklist',
  liquidity: 'this market is too quiet to fill without slipping',
  activity: 'the coin itself is barely traded anywhere',
  spread: 'bid/ask spread too wide to fill cleanly',
  changeBand: '24h move outside the gain band',
  age: 'too newly listed',
  trend: 'not in a confirmed uptrend (price under its short EMA, or weak ADX)',
};

/** Plain-language "why is this coin in or out" line for a universe candidate. */
export const reasonOf = (c: DiscoveryCandidate): string => {
  switch (c.disposition) {
    case 'added':
      return 'rotated in this scan';
    case 'kept':
      return 'in the auto-set';
    case 'faded-held':
      return 'no longer qualifies — held until the min-hold elapses, then dropped';
    case 'faded-removed':
      return 'no longer qualifies — dropping to cash this scan';
    case 'cooldown':
      return 'eligible, but on the re-add cooldown';
    case 'slot-capped':
      return 'eligible, but the auto-symbol slots are full';
    case 'correlation-high':
      return 'eligible, but moves too closely with a coin already held (would not diversify)';
    case 'sibling-owns-base':
      return 'blocked — another profile on this account already trades this coin';
    case 'sibling-quotes-base':
      return 'blocked — another profile on this account uses this coin as its quote currency';
    case 'rejected':
      return c.failedAt ? REJECT_REASON[c.failedAt] : 'not eligible';
  }
};

/** "passed liquidity, spread, …" so the operator sees how far a failed candidate got. */
const passedLine = (c: DiscoveryCandidate): string | null =>
  c.failedAt !== null && c.passed.length > 0
    ? `passed ${c.passed.map((f) => FILTER_LABEL[f]).join(', ')}`
    : null;

/** Auto symbols (held or being dropped) the operator can pin or eject. */
const isHeld = (d: DiscoveryDisposition): boolean =>
  d === 'added' || d === 'kept' || d === 'faded-held' || d === 'faded-removed';

/**
 * Position status for an auto symbol: it is in the trading set, but discovery
 * only subscribes it. The profile's own buy gate decides if it ever buys, so an
 * added coin is either HOLDING a position or SUBSCRIBED-and-waiting, and the two
 * read very differently for "is this making money".
 */
function PositionStatus({
  costBasis,
  quoteAsset,
}: {
  readonly costBasis: string | undefined;
  readonly quoteAsset: string;
}): React.JSX.Element {
  if (costBasis !== undefined) {
    return (
      <span className="text-fg w-full text-xs" data-testid="position-status">
        ● holding · ≈ {fmtAmount(costBasis)} {quoteAsset} cost
      </span>
    );
  }
  return (
    <span className="text-muted-fg w-full text-xs" data-testid="position-status">
      ○ no position yet — waiting for the strategy&rsquo;s entry conditions (e.g. the buy gate)
    </span>
  );
}

/**
 * The live-universe breakdown: each shortlisted or held symbol with its
 * disposition + reason, plus per-row pin / eject / block controls. "Pending
 * removal" rows (faded but still held) carry their reason inline.
 */
function DiscoveryUniverse({
  profileId,
  config,
  quoteAsset,
  universe,
  holdings,
  autoSymbols,
}: {
  readonly profileId: string;
  readonly config: StoredDiscoveryConfig;
  readonly quoteAsset: string;
  readonly universe: DiscoveryUniverseT;
  readonly holdings: readonly DiscoveryHolding[];
  readonly autoSymbols: readonly string[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const timeZone = useTimezone();
  const costBasisBySymbol = useMemo(
    () => new Map(holdings.map((h) => [h.symbol, h.quoteCostBasis])),
    [holdings],
  );
  // The universe is the last scan's frozen view; this is live membership now.
  const autoSet = useMemo(() => new Set(autoSymbols), [autoSymbols]);
  const [ejecting, setEjecting] = useState<string | null>(null);
  const [alsoBlock, setAlsoBlock] = useState(false);
  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: discoveryDashboardQueryKey(profileId) }),
      queryClient.invalidateQueries({ queryKey: profileDashboardQueryKey(profileId) }),
      // Pin flips an auto symbol to manual, so the pinned-symbols list below must refresh.
      queryClient.invalidateQueries({ queryKey: profileSymbolsQueryKey(profileId) }),
    ]);
  };
  const block = useMutation({
    mutationFn: (symbol: string) => blocklistSymbol(profileId, config, symbol),
    onSuccess: invalidate,
  });
  const pin = useMutation({
    mutationFn: (symbol: string) => pinSymbol(profileId, symbol),
    onSuccess: invalidate,
  });
  const eject = useMutation({
    mutationFn: (v: { symbol: string; blocklist: boolean }) =>
      forceEject(profileId, v.symbol, v.blocklist),
    onSuccess: async () => {
      setEjecting(null);
      setAlsoBlock(false);
      await invalidate();
    },
  });

  return (
    <Panel
      title={
        <>
          Live universe <span className="text-muted-fg">({universe.candidates.length})</span>
        </>
      }
      description={`Scanned ${formatInstant(universe.computedAtMs, timeZone)}`}
      testId="discovery-universe"
    >
      {universe.candidates.length === 0 ? (
        <p className="text-muted-fg text-sm">No candidates in the last scan.</p>
      ) : (
        <ul className="divide-border divide-y">
          {universe.candidates.map((c) => {
            const passed = passedLine(c);
            const liveAuto = autoSet.has(c.symbol);
            // The scan tagged it held, but it has since left the live auto-set
            // (operator pinned / ejected / removed it). Surface that instead of
            // the stale "held" framing so the action reads as having taken effect.
            const leftSet = isHeld(c.disposition) && !liveAuto;
            return (
              <li
                key={c.symbol}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
                data-testid={`universe-${c.symbol}`}
              >
                <span className="font-mono font-medium">{c.symbol}</span>
                {c.gainerScore !== null ? (
                  <span className="text-muted-fg font-mono text-xs tabular-nums">
                    {fmtSigned(c.gainerScore)}%
                  </span>
                ) : null}
                <Badge
                  variant={leftSet ? 'outline' : DISPOSITION[c.disposition].variant}
                  data-testid={`disposition-${c.symbol}`}
                >
                  {leftSet ? 'no longer auto' : DISPOSITION[c.disposition].label}
                </Badge>
                <span className="text-muted-fg w-full text-xs">
                  {leftSet
                    ? 'no longer in the auto-set (pinned, ejected, or removed); discovery is not managing it'
                    : reasonOf(c)}
                </span>
                {liveAuto ? (
                  <PositionStatus
                    costBasis={costBasisBySymbol.get(c.symbol)}
                    quoteAsset={quoteAsset}
                  />
                ) : null}
                {passed ? (
                  <span className="text-muted-fg w-full text-xs italic">{passed}</span>
                ) : null}
                {liveAuto && c.entryBlocker ? (
                  <span className="text-muted-fg w-full text-xs">
                    {glossEntryBlocker(c.entryBlocker)}
                  </span>
                ) : null}
                <div className="ml-auto flex gap-1">
                  {liveAuto ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => pin.mutate(c.symbol)}
                        disabled={pin.isPending}
                        aria-label={`Pin ${c.symbol}`}
                      >
                        Pin
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setAlsoBlock(false);
                          setEjecting(c.symbol);
                        }}
                        aria-label={`Eject ${c.symbol}`}
                      >
                        Eject
                      </Button>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => block.mutate(c.symbol)}
                    disabled={block.isPending}
                    aria-label={`Block ${c.symbol}`}
                  >
                    Block
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={ejecting !== null}
        onOpenChange={(open) => {
          if (!open) setEjecting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eject {ejecting}?</DialogTitle>
            <DialogDescription>
              Sells the whole position to cash on the next tick and starts the re-add cooldown so
              discovery does not rotate it straight back in.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={alsoBlock}
              onChange={(e) => setAlsoBlock(e.target.checked)}
              aria-label="Also block from re-adding"
            />
            Also block from re-adding
          </label>
          <FormActions>
            <Button type="button" size="sm" variant="outline" onClick={() => setEjecting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={eject.isPending}
              onClick={() => {
                if (ejecting) eject.mutate({ symbol: ejecting, blocklist: alsoBlock });
              }}
            >
              Eject
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

/** Recent discovery add/remove pushes, projected from the profile's action log. */
function DiscoveryActivity({
  activity,
}: {
  readonly activity: readonly DiscoveryActivityEntry[];
}): React.JSX.Element {
  const timeZone = useTimezone();
  return (
    <Panel title="Recent activity" testId="discovery-activity">
      <ul className="divide-border divide-y">
        {activity.map((e) => (
          <li
            key={`${e.time}-${e.symbol}-${e.action}`}
            className="flex items-baseline gap-2 py-1.5 text-sm"
          >
            <Badge variant="outline">{e.action}</Badge>
            <span className="font-mono">{e.symbol}</span>
            <time className="text-muted-fg ml-auto font-mono text-xs tabular-nums">
              {formatInstant(e.time, timeZone)}
            </time>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Schema-driven editor for the discovery thresholds. `enabled` is owned by the
 * card's on/off switch, so it is stripped from the form (one control, no
 * divergence) and re-attached from the current config at submit. The JSON
 * Schema is derived from `DiscoveryConfigSchema` client-side. Discovery config
 * lives in `@app/contracts` (already in the SPA bundle), so there is no
 * strategy-plugin boundary forcing it over the wire, and no payload to bloat.
 */
function DiscoveryConfigEditor({
  profileId,
  config,
}: {
  readonly profileId: string;
  readonly config: StoredDiscoveryConfig;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  // Same conversion the API runs for strategy configs, minus `enabled`.
  const schema = useMemo(() => {
    const full = toConfigJsonSchema(DiscoveryConfigSchema) as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    } & Record<string, unknown>;
    const properties = { ...(full.properties ?? {}) };
    delete properties['enabled'];
    return { ...full, properties, required: (full.required ?? []).filter((k) => k !== 'enabled') };
  }, []);
  const defaults = useMemo(() => {
    const rest: Record<string, unknown> = { ...config };
    delete rest['enabled'];
    return rest;
  }, [config]);

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      patchDiscoveryConfig(profileId, {
        ...values,
        enabled: config.enabled,
      } as StoredDiscoveryConfig),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Settings saved.' });
      await queryClient.invalidateQueries({ queryKey: discoveryDashboardQueryKey(profileId) });
    },
    onError: (e) =>
      setBanner({ kind: 'err', message: e instanceof Error ? e.message : 'save failed' }),
  });

  return (
    // Tuning behind the master on/off switch above: advanced, rarely touched, so
    // it stays a closed disclosure. groupLooseFields=false because this Panel is
    // already the section box, so AutoForm must not add its own "Core settings" box.
    <Panel
      title="Discovery settings"
      description="Tune what discovery looks for. Use the switch above to pause it."
      collapsible
      defaultOpen={false}
      testId="discovery-config-editor"
    >
      <AutoForm
        jsonSchema={schema}
        defaultValues={defaults}
        onSubmit={(values) => save.mutate(values)}
        submitError={save.error}
        groupLooseFields={false}
      >
        <ActionBanner banner={banner} />
        <FormActions className="border-border items-center gap-3 border-t pt-4">
          <Button type="submit" variant="default" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </FormActions>
      </AutoForm>
    </Panel>
  );
}

/**
 * The operator's pinned (manual) symbols: coins they added or pinned, which
 * the bot trades and discovery will not rotate out. Discovery_config holds no
 * symbol list, so without this the roster is invisible here — the source of the
 * "where are my pinned symbols?" confusion, since "Manual (pinned)" is the very
 * label the P/L-by-source band uses. Each row offers Unpin (hand back to
 * discovery) and Remove (detach the binding). Auto symbols live in the
 * live-universe list below, so this filters to `manual` only.
 */
function ManualSymbols({ profileId }: { readonly profileId: string }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const query = useQuery(profileSymbolsQueryOptions(profileId));
  const [removing, setRemoving] = useState<string | null>(null);
  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: profileSymbolsQueryKey(profileId) }),
      queryClient.invalidateQueries({ queryKey: discoveryDashboardQueryKey(profileId) }),
      queryClient.invalidateQueries({ queryKey: profileDashboardQueryKey(profileId) }),
    ]);
  };
  const unpin = useMutation({
    mutationFn: (symbol: string) => unpinSymbol(profileId, symbol),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (symbol: string) => wipeSymbol(profileId, symbol),
    onSuccess: async () => {
      setRemoving(null);
      await invalidate();
    },
  });

  // A discovery-dashboard read error must not break the rest of the panel; this
  // is a secondary list, so stay silent until it loads (mirrors the dashboard's
  // own error-is-null stance).
  if (query.isLoading || query.isError || !query.data) return null;
  const manual = query.data.filter((s) => s.source === 'manual');

  return (
    <Panel
      title={
        <>
          Pinned symbols <span className="text-muted-fg">({manual.length})</span>
        </>
      }
      description={`Coins you added or pinned. The bot trades these and discovery won't rotate them out. These are what "Manual (pinned)" counts in your P/L by source.`}
      testId="manual-symbols"
    >
      {manual.length === 0 ? (
        <p className="text-muted-fg text-sm" data-testid="manual-symbols-empty">
          No pinned symbols. Pin a coin from the live universe below, or add one from the dashboard.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {manual.map((s) => (
            <li
              key={s.symbol}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
              data-testid={`manual-${s.symbol}`}
            >
              <span className="font-mono font-medium">{s.symbol}</span>
              <div className="ml-auto flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => unpin.mutate(s.symbol)}
                  disabled={unpin.isPending}
                  aria-label={`Unpin ${s.symbol}`}
                >
                  Unpin
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoving(s.symbol)}
                  aria-label={`Remove ${s.symbol}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing}?</DialogTitle>
            <DialogDescription>
              Stops the bot trading {removing} and clears its cost basis. It does not sell any open
              position — sell or eject first if you hold one. Past trade history is kept.
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button type="button" size="sm" variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (removing) remove.mutate(removing);
              }}
            >
              Remove
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

export function DiscoveryDashboard({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const timeZone = useTimezone();
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const query = useQuery(discoveryDashboardQueryOptions(profileId));
  const data = query.data;
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!data) throw new Error('discovery config not loaded');
      return patchDiscoveryConfig(profileId, { ...data.config, enabled });
    },
    onSuccess: async () => {
      setBanner(null);
      await queryClient.invalidateQueries({ queryKey: discoveryDashboardQueryKey(profileId) });
    },
    onError: (e) =>
      setBanner({ kind: 'err', message: e instanceof Error ? e.message : 'update failed' }),
  });

  if (query.isLoading) {
    return <p className="text-muted-fg text-sm">Loading discovery…</p>;
  }
  // A discovery endpoint error must not break the rest of the profile page.
  if (query.isError || !data) return null;
  const { config, configInvalid, quoteAsset, scoreboard, gauge, holdings, autoSymbols } = data;
  // Discovery subscribes a coin; the profile's buy gate decides if it ever
  // buys. Flag the case where coins were added but none have entered, so a
  // running-but-earning-nothing set does not read as success.
  const addedButWaiting = config.enabled && gauge.autoSymbolCount > 0 && holdings.length === 0;

  return (
    <div className="space-y-6" data-testid="discovery-dashboard">
      <Panel
        title="Auto-discovery"
        description="Automatically shortlists and rotates coins to trade, within your exposure cap."
        actions={
          <div className="flex items-center gap-2">
            {config.enabled ? (
              <Badge variant="default">on</Badge>
            ) : (
              <Badge variant="outline">off</Badge>
            )}
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-fg">Run discovery</span>
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => toggle.mutate(v)}
                disabled={toggle.isPending}
                aria-label="toggle discovery"
              />
            </label>
          </div>
        }
      >
        <div className="space-y-4">
          <ActionBanner banner={banner} />

          {configInvalid ? (
            <p
              className="rounded-xs border-down text-down border p-2 text-sm"
              role="alert"
              data-testid="discovery-config-invalid"
            >
              Your saved discovery settings are invalid and are not being applied — discovery is
              paused until you fix them. The values shown below are safe defaults; edit them and
              press Save settings to repair.
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="discovery-scoreboard">
            <Tile
              label="Realized P/L (auto)"
              value={fmtSigned(scoreboard.realizedProfit)}
              tone={toneClass(scoreboard.realizedProfit)}
              testId="discovery-net-pl"
            />
            <Tile
              label="7-day P/L"
              value={fmtSigned(scoreboard.realizedProfit7d)}
              tone={toneClass(scoreboard.realizedProfit7d)}
            />
            <Tile label="Trades" value={String(scoreboard.tradeCount)} />
            <Tile label="Win rate" value={formatWinRate(scoreboard.winRate)} />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="discovery-gauge">
            <Tile label="Deployed" value={fmtAmount(gauge.deployedQuote)} />
            <Tile
              label="Exposure cap"
              value={gauge.maxAccountExposureQuote ? fmtAmount(gauge.maxAccountExposureQuote) : '—'}
            />
            <Tile
              label="Auto symbols"
              value={String(gauge.autoSymbolCount)}
              testId="discovery-auto-count"
            />
          </div>
          <p className="text-muted-fg -mt-2 text-xs">
            Deployed and the cap are account-wide, across every profile.
          </p>

          {addedButWaiting ? (
            <p className="text-muted-fg text-xs" role="status" data-testid="discovery-waiting-note">
              Holding {gauge.autoSymbolCount} auto symbol{gauge.autoSymbolCount === 1 ? '' : 's'},
              but none have entered a position yet. Discovery subscribes a coin; the strategy buys
              it only once its own entry conditions hold (e.g. the technicals buy gate). Open a
              symbol to see what it is waiting on.
            </p>
          ) : null}

          {config.enabled && gauge.autoSymbolCount === 0 ? (
            <p className="text-muted-fg text-xs" data-testid="discovery-zero-note">
              {data.universe
                ? `Scanning every ${fmtPeriod(config.refreshPeriodMs)}. Nothing met the bar in the last scan (${formatClock(data.universe.computedAtMs, timeZone)}). That is normal when the market is flat.`
                : `Scanning every ${fmtPeriod(config.refreshPeriodMs)}. First scan pending.`}
            </p>
          ) : null}
        </div>
      </Panel>

      <ManualSymbols profileId={profileId} />

      <DiscoveryConfigEditor profileId={profileId} config={config} />

      {data.universe ? (
        <DiscoveryUniverse
          profileId={profileId}
          config={config}
          quoteAsset={quoteAsset}
          universe={data.universe}
          holdings={holdings}
          autoSymbols={autoSymbols}
        />
      ) : null}
      {data.activity.length > 0 ? <DiscoveryActivity activity={data.activity} /> : null}
    </div>
  );
}
