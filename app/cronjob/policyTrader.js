// app/cronjob/policyTrader.js
// Enkel policy-basert trader for Cross-Margin
// Leser signal (stub), sjekker sikkerhetsgrenser, plasserer ordre via placeOrderRouted

require('dotenv').config();
const slack = require('../helpers/slack'); // ← endret her
const { getMarginAccount } = require('../binance/margin');
const { placeOrderRouted } = require('../helpers/placeOrderRouted');

const DEFAULT_QTY_USD = parseFloat(process.env.AI_TRADER_DEFAULT_QTY_USD || '25');
const MAX_BORROW_RATIO = parseFloat(process.env.AI_TRADER_MAX_BORROW_RATIO || '0.30');
const MIN_LEVEL = parseFloat(process.env.AI_TRADER_MIN_LEVEL || '1.50');
const DRY_RUN = String(process.env.AI_TRADER_DRY_RUN || 'true').toLowerCase() === 'true';
const SYMBOLS = (process.env.AI_TRADER_SYMBOLS || 'BTCUSDC').split(',').map(s => s.trim().toUpperCase());

function num(v, dp = 6) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(dp) : '0';
}

// === Signal-stub (erstattes senere med ekte signaler) ===
async function getSignal(symbol) {
  // Til testing: returner BUY, SELL eller HOLD
  const r = Math.random();
  if (r < 0.33) return 'BUY';
  if (r < 0.66) return 'SELL';
  return 'HOLD';
}

async function run() {
  console.log('[policyTrader] Start');

  const acct = await getMarginAccount();
  const level = parseFloat(acct.marginLevel || acct.collateralMarginLevel || 0);
  const totalAssetOfBtc = parseFloat(acct.totalAssetOfBtc || 0);
  const totalLiabilityOfBtc = parseFloat(acct.totalLiabilityOfBtc || 0);
  const borrowRatio = totalAssetOfBtc > 0 ? totalLiabilityOfBtc / totalAssetOfBtc : 0;

  for (const symbol of SYMBOLS) {
    const action = await getSignal(symbol);

    if (action === 'HOLD') {
      console.log(`[policyTrader] ${symbol} → HOLD`);
      continue;
    }

    // Sikkerhetsregler
    if (borrowRatio > MAX_BORROW_RATIO) {
      console.log(`[policyTrader] ${symbol} → STOPP pga. borrowRatio=${num(borrowRatio, 3)} > ${MAX_BORROW_RATIO}`);
      await slack.sendMessage(`(policyTrader) Stopper handel for ${symbol} – borrowRatio ${num(borrowRatio * 100, 1)}% over ${MAX_BORROW_RATIO * 100}%`);
      continue;
    }
    if (level < MIN_LEVEL) {
      console.log(`[policyTrader] ${symbol} → STOPP pga. marginLevel=${num(level, 3)} < ${MIN_LEVEL}`);
      await slack.sendMessage(`(policyTrader) Stopper handel for ${symbol} – marginLevel ${num(level, 3)} under ${MIN_LEVEL}`);
      continue;
    }

    // Ordreparams
    const side = action === 'BUY' ? 'BUY' : 'SELL';
    const params = {
      autoBorrow: side === 'BUY',
      autoRepay: side === 'SELL'
    };

    if (DRY_RUN) {
      console.log(`[policyTrader][DRY-RUN] ${side} ${DEFAULT_QTY_USD} ${symbol}`);
      await slack.sendMessage(`(policyTrader DRY-RUN) ${side} ${DEFAULT_QTY_USD} ${symbol}`);
    } else {
      try {
        const resp = await placeOrderRouted(symbol.replace(/USDC|USDT/, ''), side, DEFAULT_QTY_USD, { ...params, quoteOrderQty: DEFAULT_QTY_USD });
        console.log(`[policyTrader] ${side} OK: ${JSON.stringify(resp)}`);
        await slack.sendMessage(`(policyTrader) ${side} ${DEFAULT_QTY_USD} ${symbol} – OK`);
      } catch (err) {
        console.error(`[policyTrader] Feil ved ordre:`, err);
        await slack.sendMessage(`(policyTrader) Feil ved ordre for ${symbol}: ${err.message}`);
      }
    }
  }

  console.log('[policyTrader] Ferdig');
}

if (require.main === module) {
  run().catch(err => {
    console.error('[policyTrader] Uventet feil:', err);
    process.exit(1);
  });
}

module.exports = { run };
