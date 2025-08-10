// app/cronjob/interestTracker.js
// Overvåker Cross Margin: borrow-ratio, estimert daglig rentekost for valgt stable-coin,
// og sender Slack-varsel når terskel brytes – men med enkel rate-limit/delta-sjekk.

require('dotenv').config();
const { slack } = require('../helpers');
const { getMarginAccount } = require('../binance/margin');
const cache = require('../helpers/cache'); // forventer cache.get(key) / cache.set(key, val, ttlSec)

// ===== Konfig fra .env =====
const STABLE_ASSET = (process.env.MARGIN_STABLE_ASSET || 'USDT').toUpperCase();

// Terskel for å i det hele tatt varsle (borrow ratio = liability / asset)
const ALERT_BORROW_RATIO = Math.max(
  0,
  Math.min(1, parseFloat(process.env.MARGIN_INTEREST_BORROW_RATIO_THRESHOLD || '0.50'))
);

// Rate-limit/delta-regler for Slack-varsler
// Minste "absolutt" endring i borrow-ratio i prosentpoeng (0.10 = 10 %-poeng)
const ALERT_MIN_DELTA = Math.max(0, parseFloat(process.env.INTEREST_ALERT_MIN_DELTA || '0.10'));
// Minimum minutter mellom to varsler
const ALERT_MIN_MINUTES = Math.max(0, parseFloat(process.env.INTEREST_ALERT_MIN_MINUTES || '30'));

// APR-konfig
const APR_DEFAULT = Math.max(0, parseFloat(process.env.MARGIN_INTEREST_APR_DEFAULT || '0.12'));
let APR_MAP = {};
try {
  APR_MAP = JSON.parse(process.env.MARGIN_APR_JSON || '{}'); // f.eks {"USDT":0.11,"USDC":0.10}
} catch {
  APR_MAP = {};
}

// ===== Hjelpere =====
const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const fmt = (v, dp = 6) => Number(num(v)).toFixed(dp);

const pickAPR = asset => {
  const key = String(asset || '').toUpperCase();
  const apr = APR_MAP[key];
  return Number.isFinite(apr) && apr >= 0 ? apr : APR_DEFAULT;
};

const groupAssets = acct => {
  const assets = acct.userAssets || acct.assets || [];
  const out = [];
  for (const a of assets) {
    const asset = String(a.asset).toUpperCase();
    const free = num(a.free);
    const locked = num(a.locked);
    const borrowed = num(a.borrowed);
    const interest = num(a.interest);
    const outstanding = borrowed + interest;
    if (free > 0 || locked > 0 || outstanding > 0) {
      out.push({ asset, free, locked, borrowed, interest, outstanding });
    }
  }
  return out.sort((x, y) => y.outstanding - x.outstanding);
};

const minutesDiff = (fromMs, toMs) => (toMs - fromMs) / 60000;

// ===== Hovedkjøringen =====
async function run() {
  console.log('[interestTracker] Start');

  const acct = await getMarginAccount();

  // Borrow ratio (liability / asset)
  const totalAssetOfBtc = num(acct.totalAssetOfBtc);
  const totalLiabilityOfBtc = num(acct.totalLiabilityOfBtc);
  const borrowRatio = totalAssetOfBtc > 0 ? totalLiabilityOfBtc / totalAssetOfBtc : 0;

  const level =
    num(acct.collateralMarginLevel) ||
    num(acct.marginLevel) ||
    0;

  const assets = groupAssets(acct);

  // Kost-estimat for valgt stable-coin
  const estimates = [];
  for (const row of assets) {
    if (row.asset !== STABLE_ASSET) continue;
    const apr = pickAPR(row.asset);
    const dailyRate = apr / 365;
    estimates.push({
      asset: row.asset,
      outstanding: row.outstanding,
      apr,
      estDailyCost: row.outstanding * dailyRate
    });
  }

  const summary = {
    level,
    borrowRatio,
    assets: assets.map(a => ({
      asset: a.asset,
      free: fmt(a.free),
      borrowed: fmt(a.borrowed),
      interest: fmt(a.interest),
      outstanding: fmt(a.outstanding)
    })),
    stableDailyCosts: estimates.map(e => ({
      asset: e.asset,
      outstanding: fmt(e.outstanding, 4),
      apr: +(e.apr),
      estDailyCost: fmt(e.estDailyCost, 4)
    }))
  };

  console.log('[interestTracker] Summary:', JSON.stringify(summary, null, 2));

  // Skal vi varsle?
  if (borrowRatio > ALERT_BORROW_RATIO) {
    // Rate-limit/delta: hent forrige varsling (lagret i cache)
    let last = {};
    try {
      last = (await cache.get('interest:lastAlert')) || {};
    } catch {
      last = {};
    }

    const now = Date.now();
    const lastAt = Number(last.timestamp || 0);
    const lastRatio = Number(last.borrowRatio || 0);

    const minutesSinceLast = lastAt ? minutesDiff(lastAt, now) : Infinity;
    const absDeltaPctPoints = Math.abs((borrowRatio - lastRatio) * 100); // prosentpoeng

    const allowByTime = minutesSinceLast >= ALERT_MIN_MINUTES;
    const allowByDelta = absDeltaPctPoints >= ALERT_MIN_DELTA * 100;

    if (!allowByTime || !allowByDelta) {
      console.log(
        `[interestTracker] Skipper varsel (rate-limited); minutesSinceLast=${fmt(minutesSinceLast, 1)}, Δpp=${fmt(absDeltaPctPoints, 2)}, borrowRatio=${fmt(borrowRatio, 4)}`
      );
    } else {
      // Bygg Slack-melding (ren – uten API-bruk)
      const timeStr = new Date().toTimeString().slice(0, 8);
      const header = `(${timeStr}) *Cross Margin – Borrow ratio høyt*`;
      const lines = [
        `- Margin level: *${fmt(level, 3)}*`,
        `- Borrow ratio: *${fmt(borrowRatio * 100, 2)}%* (terskel ${fmt(ALERT_BORROW_RATIO * 100, 0)}%)`
      ];

      if (summary.stableDailyCosts.length) {
        lines.push(`- Estimert daglig rentekost (${STABLE_ASSET}):`);
        lines.push(
          ...summary.stableDailyCosts.map(
            e => `  • ${e.asset}: ~${e.estDailyCost} pr dag (utestående ${e.outstanding}, APR ${e.apr})`
          )
        );
      } else {
        lines.push(`- Ingen ${STABLE_ASSET}-lån registrert for kostnadsestimat.`);
      }

      const message = `${header}\n${lines.join('\n')}`;

      try {
        if (slack && typeof slack.sendMessage === 'function') {
          await slack.sendMessage(message);
        }
      } catch (e) {
        console.error('[interestTracker] Slack error:', e.message);
      }

      // Lagre siste varsel
      try {
        await cache.set(
          'interest:lastAlert',
          { timestamp: now, borrowRatio },
          60 * 60 * 24 // TTL 24t – ufarlig, fornyes ved hvert varsel
        );
      } catch (e) {
        // ikke kritisk
      }
    }
  }

  console.log('[interestTracker] Done.');
}

module.exports = { run };

// Tillat manuell kjøring: `node app/cronjob/interestTracker.js`
if (require.main === module) {
  run().catch(err => {
    console.error('[interestTracker] ERROR:', err.message, err.body || '');
    process.exit(1);
  });
}
