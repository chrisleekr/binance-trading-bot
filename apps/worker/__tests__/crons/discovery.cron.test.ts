import type { Job, Queue } from 'bullmq';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BinanceRestClient, ParsedKline, Ticker24hrDto } from '@app/binance';
import {
  ASSET_POLICY_ABORT_CAUSES,
  asAccountId,
  asProfileId,
  asUserId,
  DiscoveryConfigSchema,
} from '@app/contracts';
import type { ProfileRepo } from '@app/db';
import type { NotifyProviderRegistry } from '@app/notify';
import type { SymbolInfo } from '@app/strategy-core';

import type { BootContext } from '../../src/boot/boot-context.js';
import { buildDiscoveryCron } from '../../src/crons/discovery.cron.js';
import { DISCOVERY_REAP_OUTCOMES } from '../../src/crons/discovery-reap.js';
import { applyDiscoveryAdd, applyDiscoveryReap } from '../../src/crons/discovery/apply.js';
import type { AssetPolicy } from '../../src/crons/discovery/asset-policy.js';
import { notifyDiscovery } from '../../src/crons/discovery/notify.js';
import {
  runDiscoveryForProfile,
  type DiscoveryProfileContext,
  type DiscoveryProfilePort,
} from '../../src/crons/discovery/run.js';
import type { SymbolAdmission } from '../../src/crons/discovery/symbol-admission.js';
import type { MetricsSink } from '../../src/metrics/catalog.js';
import type { ActiveProfile } from '../../src/profile-manager/profile-manager.js';
import { QUEUE_NAMES } from '../../src/queues/queue-names.js';

const mocked = vi.hoisted(() => ({
  accountsBinanceModeById: vi.fn(),
  applyDiscoveryAdd: vi.fn(),
  applyDiscoveryReap: vi.fn(),
  createBinanceRest: vi.fn(),
  findOwningSiblingByBase: vi.fn(),
  isProfileEventEnabled: vi.fn(),
  listForAccount: vi.fn(),
  notifyDiscovery: vi.fn(),
  profileRepo: vi.fn(),
  readAccountPermissions: vi.fn(),
  runDiscoveryForProfile: vi.fn(),
  scopeAccount: vi.fn(),
  shouldRunProfile: vi.fn(),
  writeAccountPermissions: vi.fn(),
}));

vi.mock('@app/binance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/binance')>();
  return { ...actual, createBinanceRest: mocked.createBinanceRest };
});

vi.mock('@app/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/db')>();
  return {
    ...actual,
    profileRepo: mocked.profileRepo,
    scopeAccount: mocked.scopeAccount,
    repo: {
      ...actual.repo,
      accounts: { ...actual.repo.accounts, binanceModeById: mocked.accountsBinanceModeById },
      profiles: { ...actual.repo.profiles, listForAccount: mocked.listForAccount },
      profileSymbols: {
        ...actual.repo.profileSymbols,
        findOwningSiblingByBase: mocked.findOwningSiblingByBase,
      },
    },
  };
});

vi.mock('../../src/crons/discovery/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crons/discovery/run.js')>();
  return { ...actual, runDiscoveryForProfile: mocked.runDiscoveryForProfile };
});

vi.mock('../../src/crons/discovery/gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crons/discovery/gate.js')>();
  return { ...actual, shouldRunProfile: mocked.shouldRunProfile };
});

vi.mock('../../src/lib/account-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/account-permissions.js')>();
  return {
    ...actual,
    readAccountPermissions: mocked.readAccountPermissions,
    writeAccountPermissions: mocked.writeAccountPermissions,
  };
});

vi.mock('../../src/notifiers/notify-event.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/notifiers/notify-event.js')>();
  return { ...actual, isProfileEventEnabled: mocked.isProfileEventEnabled };
});

vi.mock('../../src/crons/discovery/notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crons/discovery/notify.js')>();
  return { ...actual, notifyDiscovery: mocked.notifyDiscovery };
});

vi.mock('../../src/crons/discovery/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/crons/discovery/apply.js')>();
  return {
    ...actual,
    applyDiscoveryAdd: mocked.applyDiscoveryAdd,
    applyDiscoveryReap: mocked.applyDiscoveryReap,
  };
});

const NOW = 1_700_000_000_000;
const OPERATOR_ID = asUserId('00000000-0000-4000-8000-000000000001');
const USER_ID = asUserId('00000000-0000-4000-8000-000000000002');
const ACCOUNT_ID = asAccountId('00000000-0000-4000-8000-000000000003');
const PROFILE_ID = asProfileId('00000000-0000-4000-8000-000000000004');

const activeProfile: ActiveProfile = {
  userId: USER_ID,
  operatorId: OPERATOR_ID,
  accountId: ACCOUNT_ID,
  profileId: PROFILE_ID,
  candleInterval: '1h',
  symbols: [],
  technicalsIntervals: [],
};

const discoveryConfig = DiscoveryConfigSchema.parse({ enabled: true, refreshPeriodMs: 60_000 });

const profileRow: Awaited<ReturnType<ProfileRepo['profile']['findById']>> = {
  id: PROFILE_ID,
  accountId: ACCOUNT_ID,
  name: 'Momentum',
  strategyName: 'momentum',
  strategyVersion: '1',
  config: {},
  state: {},
  enabled: true,
  quoteAsset: 'usdt',
  benchmarkMode: 'btc',
  baselineBacktestRunId: null,
  discoveryConfig,
  riskConfig: null,
  enablementPolicy: null,
  notifyEvents: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const symbolRows: Awaited<ReturnType<ProfileRepo['profileSymbols']['listForProfile']>> = [
  {
    profileId: PROFILE_ID,
    symbol: 'ROTATEUSDT',
    baseAsset: 'ROTATE',
    overrideConfig: null,
    source: 'auto',
    pinned: false,
    pinnedAt: null,
    lastFlattenAt: new Date(300),
  },
  {
    profileId: PROFILE_ID,
    symbol: 'PINUSDT',
    baseAsset: 'PIN',
    overrideConfig: null,
    source: 'manual',
    pinned: true,
    pinnedAt: new Date(100),
    lastFlattenAt: null,
  },
  {
    profileId: PROFILE_ID,
    symbol: 'DBONLYUSDT',
    baseAsset: 'DBONLY',
    overrideConfig: null,
    source: 'unknown',
    pinned: false,
    pinnedAt: null,
    lastFlattenAt: new Date(350),
  },
];

const parsedKline: ParsedKline = {
  openTimeMs: 1,
  closeTimeMs: 2,
  open: '10',
  high: '12',
  low: '9',
  close: '11',
  volume: '5',
};

const ticker: Ticker24hrDto = {
  symbol: 'ETHUSDT',
  priceChange: '1',
  priceChangePercent: '2',
  lastPrice: '11',
  highPrice: '12',
  lowPrice: '9',
  openPrice: '10',
  volume: '5',
  quoteVolume: '55',
  bidPrice: '10.9',
  askPrice: '11.1',
};

const symbolInfo: SymbolInfo = {
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minQty: '0.01',
    stepSize: '0.01',
    minNotional: '10',
    tickSize: '0.01',
    maxQty: '1000000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
};

const admission = new Map<string, SymbolAdmission>([
  ['ETHUSDT', { status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT' }],
]);

const assetPolicy: AssetPolicy = {
  stablecoinOrFiatBases: new Set(['USDT']),
  taggedStablecoinBases: new Set(['USDT']),
  fiatQuoteAssets: new Set(['USD']),
  tradingSymbols: new Set(['ETHUSDT']),
};

describe('buildDiscoveryCron adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  it('drives every DiscoveryProfilePort binding through the intended dependency', async () => {
    const logger = pino({ level: 'silent' });
    const hgetall = vi.fn(async (key: string) => {
      if (key === `discovery:added:${PROFILE_ID}`) return { ROTATEUSDT: '100', invalid: 'NaN' };
      if (key === `discovery:flat:${PROFILE_ID}`) return { ROTATEUSDT: '200', REDISONLY: '400' };
      return {};
    });
    const hset = vi.fn(async () => 1);
    const hdel = vi.fn(async () => 1);
    const set = vi.fn(async () => 'OK' as const);
    const del = vi.fn(async () => 1);
    const redis = {
      hgetall,
      hset,
      hdel,
      set,
      del,
    };

    const findById = vi.fn<ProfileRepo['profile']['findById']>(async () => profileRow);
    const recordCondition = vi.fn<ProfileRepo['conditionStates']['recordCondition']>(async () => ({
      changed: false,
      sinceMs: null,
    }));
    const listForProfile = vi.fn<ProfileRepo['profileSymbols']['listForProfile']>(
      async () => symbolRows,
    );
    const actionLogAppend = vi.fn<ProfileRepo['actionLogs']['append']>(async () => undefined);
    const notifierRows = [
      {
        id: '00000000-0000-4000-8000-000000000005',
        profileId: PROFILE_ID,
        provider: 'slack',
        config: { channel: '#trading' },
        secrets: { webhookUrl: 'secret' },
        enabled: true,
        createdAt: new Date(0),
      },
    ];
    const listNotifiers = vi.fn<ProfileRepo['profileNotifiers']['listForProfile']>(
      async () => notifierRows,
    );
    const recordSnapshot = vi.fn<ProfileRepo['discoveryUniverseSnapshots']['record']>(
      async (snapshot) => ({
        id: '00000000-0000-4000-8000-000000000007',
        profileId: PROFILE_ID,
        capturedAt: new Date(0),
        snapshot,
      }),
    );
    const profileSymbols = {
      listForProfile,
      findForSymbol: vi.fn(),
      upsert: vi.fn(),
      setSource: vi.fn(),
      removeUnpinnedIfFlat: vi.fn(),
    } satisfies Pick<
      ProfileRepo['profileSymbols'],
      'listForProfile' | 'findForSymbol' | 'upsert' | 'setSource' | 'removeUnpinnedIfFlat'
    >;
    const repo = {
      profile: { findById },
      conditionStates: { recordCondition },
      profileSymbols,
      profileNotifiers: { listForProfile: listNotifiers },
      actionLogs: { append: actionLogAppend },
      discoveryUniverseSnapshots: { record: recordSnapshot },
    };
    mocked.profileRepo.mockResolvedValue(repo);

    const rest = {
      getKlines: vi.fn<BinanceRestClient['getKlines']>(async () => [parsedKline]),
      getAllTickers24hr: vi.fn<BinanceRestClient['getAllTickers24hr']>(async () => [ticker]),
    } satisfies Pick<BinanceRestClient, 'getKlines' | 'getAllTickers24hr'>;
    mocked.createBinanceRest.mockReturnValue(rest);

    const getAccount = vi.fn<BinanceRestClient['getAccount']>(async () => ({
      balances: [{ asset: 'ETH', free: '0.4', locked: '0.1' }],
      canTrade: true,
      permissions: ['SPOT'],
    }));
    const binanceClient = { getAccount } satisfies Pick<BinanceRestClient, 'getAccount'>;
    const resolveBinanceClient = vi.fn<BootContext['resolveBinanceClient']>(
      async () => binanceClient as unknown as BinanceRestClient,
    );
    const getSymbolInfo = vi.fn(async () => symbolInfo);
    const getSymbolAdmission = vi.fn(async () => admission);
    const getAssetPolicy = vi.fn(async () => assetPolicy);
    const metrics = {
      record: vi.fn<MetricsSink['record']>(),
      forget: vi.fn<MetricsSink['forget']>(),
    } satisfies MetricsSink;
    const queueAdd = vi.fn<Queue['add']>(async () => ({}) as never);
    const notifyProviders = {} as NotifyProviderRegistry;
    const db = { marker: 'db' } as unknown as BootContext['db'];
    const redisClient = redis as unknown as BootContext['redis'];
    const weightGovernor = {
      marker: 'weight-governor',
    } as unknown as BootContext['weightGovernor'];
    const queueSet = {
      queues: { [QUEUE_NAMES.pipeline]: { add: queueAdd } },
    } as unknown as BootContext['queueSet'];
    const contextFields = {
      logger,
      db,
      redis: redisClient,
      listActive: () => [activeProfile],
      weightGovernor,
      resolveBinanceClient,
      getSymbolInfo,
      getSymbolAdmission,
      getAssetPolicy,
      metrics,
      notifyProviders,
      liveDemo: false,
      queueSet,
    } satisfies Pick<
      BootContext,
      | 'logger'
      | 'db'
      | 'redis'
      | 'listActive'
      | 'weightGovernor'
      | 'resolveBinanceClient'
      | 'getSymbolInfo'
      | 'getSymbolAdmission'
      | 'getAssetPolicy'
      | 'metrics'
      | 'notifyProviders'
      | 'liveDemo'
      | 'queueSet'
    >;

    mocked.shouldRunProfile.mockResolvedValue(true);
    mocked.readAccountPermissions.mockResolvedValue(['SPOT']);
    mocked.writeAccountPermissions.mockResolvedValue(undefined);
    mocked.accountsBinanceModeById.mockResolvedValue('live');
    const accountScope = { marker: 'account-scope' };
    mocked.scopeAccount.mockResolvedValue(accountScope);
    mocked.listForAccount.mockResolvedValue([
      { id: PROFILE_ID, quoteAsset: 'USDT' },
      { id: '00000000-0000-4000-8000-000000000006', quoteAsset: 'eth' },
    ]);
    mocked.findOwningSiblingByBase.mockResolvedValue(null);
    mocked.isProfileEventEnabled.mockResolvedValue(true);
    mocked.notifyDiscovery.mockResolvedValue(undefined);
    mocked.applyDiscoveryAdd.mockResolvedValue({ outcome: 'created' });
    mocked.applyDiscoveryReap.mockResolvedValue('removed');

    let capturedPort: DiscoveryProfilePort | undefined;
    let capturedWake: DiscoveryProfileContext | undefined;
    vi.mocked(runDiscoveryForProfile).mockImplementation(async (port, config, quote, now, wake) => {
      capturedPort = port;
      capturedWake = wake;
      expect(config).toEqual(discoveryConfig);
      expect(quote).toBe('USDT');
      expect(now).toBe(NOW);
      return {
        added: 0,
        removed: 0,
        reapOutcomes: {
          removed: 0,
          pinned: 0,
          held: 0,
          'not-found': 0,
          'wallet-held': 0,
          'hold-unproven': 0,
        },
      };
    });

    const cron = buildDiscoveryCron(contextFields as unknown as BootContext);
    await cron.handler({} as Job);

    expect(recordCondition).toHaveBeenCalledTimes(1);
    expect(recordCondition).toHaveBeenCalledWith({
      condition: 'config-invalid',
      code: null,
      now: expect.any(Date),
      msg: 'Discovery settings parse again.',
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(`discovery:asset-policy-abort:${PROFILE_ID}`);
    expect(metrics.record).toHaveBeenCalledTimes(
      ASSET_POLICY_ABORT_CAUSES.length + DISCOVERY_REAP_OUTCOMES.length,
    );
    for (const cause of ASSET_POLICY_ABORT_CAUSES) {
      expect(metrics.record).toHaveBeenCalledWith('discovery_asset_policy_abort_total', 0, {
        profileId: PROFILE_ID,
        cause,
      });
    }
    for (const outcome of DISCOVERY_REAP_OUTCOMES) {
      expect(metrics.record).toHaveBeenCalledWith('discovery_reap_outcome_total', 0, {
        profileId: PROFILE_ID,
        outcome,
      });
    }
    expect(cron.name).toBe('discovery-run');
    expect(cron.queue).toBe(QUEUE_NAMES.discoveryRun);
    expect(cron.selfReschedulePeriodMs).toBe(60_000);
    expect(mocked.createBinanceRest).toHaveBeenCalledTimes(1);
    expect(mocked.createBinanceRest).toHaveBeenCalledWith({
      mode: 'live',
      credentials: { apiKey: '', secretKey: '' },
      weightGovernor,
    });
    expect(mocked.profileRepo).toHaveBeenCalledTimes(2);
    expect(mocked.profileRepo).toHaveBeenNthCalledWith(1, db, OPERATOR_ID, ACCOUNT_ID, PROFILE_ID);
    expect(mocked.profileRepo).toHaveBeenNthCalledWith(2, db, OPERATOR_ID, ACCOUNT_ID, PROFILE_ID);
    expect(findById).toHaveBeenCalledTimes(1);
    expect(mocked.shouldRunProfile).toHaveBeenCalledTimes(1);
    expect(mocked.shouldRunProfile).toHaveBeenCalledWith(
      redisClient,
      PROFILE_ID,
      discoveryConfig.refreshPeriodMs,
      NOW,
      logger,
    );
    expect(mocked.readAccountPermissions).toHaveBeenCalledTimes(1);
    expect(mocked.readAccountPermissions).toHaveBeenCalledWith(
      redisClient,
      logger,
      ACCOUNT_ID,
      'cron discovery',
    );
    expect(mocked.accountsBinanceModeById).toHaveBeenCalledTimes(1);
    expect(mocked.accountsBinanceModeById).toHaveBeenCalledWith(db, ACCOUNT_ID);
    expect(getSymbolAdmission).toHaveBeenCalledTimes(1);
    expect(getSymbolAdmission).toHaveBeenCalledWith('live');
    expect(getAssetPolicy).toHaveBeenCalledTimes(1);
    expect(getAssetPolicy).toHaveBeenCalledWith();
    expect(mocked.runDiscoveryForProfile).toHaveBeenCalledTimes(1);
    expect(capturedWake).toEqual({
      admissionBySymbol: admission,
      liveAdmission: admission,
      assetPolicy,
      accountPermissions: ['SPOT'],
    });
    if (!capturedPort) throw new Error('expected the public handler to build a discovery port');
    const port = capturedPort;
    expect(Object.keys(port).sort()).toEqual([
      'addSymbol',
      'addedAtBySymbol',
      'cleanupOrphanedAdded',
      'emit',
      'emitMembershipLost',
      'emitReadd',
      'enqueueResync',
      'getAllTickers',
      'getKlines',
      'heldOnExchange',
      'lastFlattenBySymbol',
      'listPinnedSymbols',
      'listRotatableSymbols',
      'logger',
      'notify',
      'persistExplain',
      'persistSnapshot',
      'reapSymbol',
      'recordReapOutcome',
      'refreshEntryHint',
      'siblingConflict',
    ]);
    expect(port.logger).toBe(logger);

    expect(await port.getAllTickers()).toEqual([ticker]);
    expect(rest.getAllTickers24hr).toHaveBeenCalledTimes(1);

    expect(await port.getKlines('ETHUSDT', 7)).toEqual([{ ...parsedKline, isClosed: true }]);
    expect(rest.getKlines).toHaveBeenCalledWith({ symbol: 'ETHUSDT', interval: '1h', limit: 7 });

    expect(await port.listRotatableSymbols()).toEqual(['ROTATEUSDT', 'DBONLYUSDT']);
    expect(await port.listPinnedSymbols()).toEqual(['PINUSDT']);
    expect(await port.addedAtBySymbol()).toEqual({ ROTATEUSDT: 100 });
    expect(await port.lastFlattenBySymbol(['ROTATEUSDT', 'DBONLYUSDT', 'REDISONLY'])).toEqual({
      ROTATEUSDT: 300,
      DBONLYUSDT: 350,
      REDISONLY: 400,
    });
    expect(listForProfile).toHaveBeenCalledTimes(1);

    expect(await port.addSymbol('ETHUSDT', NOW)).toEqual({ outcome: 'created' });
    expect(vi.mocked(applyDiscoveryAdd)).toHaveBeenCalledWith(
      profileSymbols,
      redis,
      {
        addedKey: `discovery:added:${PROFILE_ID}`,
        flatKey: `discovery:flat:${PROFILE_ID}`,
        enterOnAddKey: `discovery:enter-on-add:${PROFILE_ID}`,
      },
      'ETHUSDT',
      'ETH',
      NOW,
    );

    expect(await port.siblingConflict('ETHUSDT')).toBe('sibling-quotes-base');
    expect(mocked.findOwningSiblingByBase).toHaveBeenCalledWith(
      contextFields.db,
      ACCOUNT_ID,
      'ETH',
      PROFILE_ID,
    );
    expect(mocked.scopeAccount).toHaveBeenCalledTimes(1);
    expect(mocked.scopeAccount).toHaveBeenCalledWith(db, OPERATOR_ID, ACCOUNT_ID);
    expect(mocked.listForAccount).toHaveBeenCalledTimes(1);
    expect(mocked.listForAccount).toHaveBeenCalledWith(accountScope);

    await port.refreshEntryHint('ETHUSDT', '{"enterOnAdd":true}');
    expect(hset).toHaveBeenCalledWith(
      `discovery:enter-on-add:${PROFILE_ID}`,
      'ETHUSDT',
      '{"enterOnAdd":true}',
    );

    expect(await port.heldOnExchange('ETHUSDT')).toBe(true);
    expect(resolveBinanceClient).toHaveBeenCalledWith(OPERATOR_ID, ACCOUNT_ID);
    expect(mocked.writeAccountPermissions).toHaveBeenCalledWith(redis, ACCOUNT_ID, ['SPOT']);

    expect(await port.reapSymbol('ETHUSDT', NOW)).toBe('removed');
    expect(vi.mocked(applyDiscoveryReap)).toHaveBeenCalledWith(
      profileSymbols,
      redis,
      {
        addedKey: `discovery:added:${PROFILE_ID}`,
        flatKey: `discovery:flat:${PROFILE_ID}`,
        enterOnAddKey: `discovery:enter-on-add:${PROFILE_ID}`,
      },
      'ETHUSDT',
      NOW,
    );

    port.recordReapOutcome('held');
    expect(metrics.record).toHaveBeenCalledWith('discovery_reap_outcome_total', 1, {
      profileId: PROFILE_ID,
      outcome: 'held',
    });

    await port.emit('ETHUSDT', 'add');
    await port.emitReadd('ETHUSDT', 123);
    await port.emitMembershipLost('ETHUSDT', 456);
    expect(actionLogAppend.mock.calls.map(([entry]) => entry)).toEqual([
      {
        time: new Date(NOW),
        symbol: 'ETHUSDT',
        level: 'info',
        msg: 'Discovery added ETHUSDT',
        ctx: { source: 'auto', action: 'add' },
      },
      {
        time: new Date(NOW),
        symbol: 'ETHUSDT',
        level: 'warn',
        msg: 'Discovery re-added ETHUSDT',
        ctx: { source: 'auto', action: 'readded', prevAddedAt: 123 },
      },
      {
        time: new Date(NOW),
        symbol: 'ETHUSDT',
        level: 'warn',
        msg: 'Discovery membership lost ETHUSDT',
        ctx: { source: 'auto', action: 'membership-lost', prevAddedAt: 456 },
      },
    ]);

    await port.cleanupOrphanedAdded('ETHUSDT');
    expect(hdel).toHaveBeenCalledWith(`discovery:added:${PROFILE_ID}`, 'ETHUSDT');
    expect(hdel).toHaveBeenCalledWith(`discovery:enter-on-add:${PROFILE_ID}`, 'ETHUSDT');

    await port.notify('added', 'ETHUSDT');
    expect(mocked.isProfileEventEnabled).toHaveBeenCalledWith(
      contextFields.db,
      OPERATOR_ID,
      ACCOUNT_ID,
      PROFILE_ID,
      'discovery',
    );
    expect(vi.mocked(notifyDiscovery)).toHaveBeenCalledWith(
      notifyProviders,
      [
        {
          providerName: 'slack',
          config: { channel: '#trading', webhookUrl: 'secret' },
        },
      ],
      {
        severity: 'info',
        topic: 'discovery',
        title: 'Discovery: symbol added',
        profile: 'Momentum',
        symbol: 'ETHUSDT',
        body: 'Auto-discovery started trading ETHUSDT.',
      },
      logger,
      false,
    );
    expect(listNotifiers).toHaveBeenCalledTimes(1);
    expect(mocked.notifyDiscovery).toHaveBeenCalledTimes(1);

    mocked.isProfileEventEnabled.mockResolvedValue(false);
    await port.notify('removed', 'ETHUSDT');
    expect(mocked.isProfileEventEnabled).toHaveBeenCalledTimes(2);
    expect(mocked.isProfileEventEnabled).toHaveBeenLastCalledWith(
      contextFields.db,
      OPERATOR_ID,
      ACCOUNT_ID,
      PROFILE_ID,
      'discovery',
    );
    expect(listNotifiers).toHaveBeenCalledTimes(1);
    expect(mocked.notifyDiscovery).toHaveBeenCalledTimes(1);

    await port.persistExplain([], NOW);
    expect(set).toHaveBeenCalledWith(
      `discovery:explain:${PROFILE_ID}`,
      JSON.stringify({ computedAtMs: NOW, candidates: [] }),
    );

    const snapshot = {
      universe: [],
      shortlist: [],
      add: [],
      remove: [],
      desired: [],
      configDigest: {
        quoteAsset: 'USDT',
        maxAutoSymbols: 5,
        changeMinPercent: '0',
        rankTopPercent: 100,
        rankExcludeTopPercent: 0,
        marketBreadthMinPercent: '0',
      },
    };
    await port.persistSnapshot(snapshot);
    expect(recordSnapshot).toHaveBeenCalledWith(snapshot);

    await port.enqueueResync();
    expect(queueAdd).toHaveBeenCalledWith(
      'reconfigure-profile',
      { userId: OPERATOR_ID, accountId: ACCOUNT_ID, profileId: PROFILE_ID },
      { removeOnComplete: true, removeOnFail: { count: 1_000 } },
    );
  });
});
