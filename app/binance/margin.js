// app/binance/margin.js
// Cross Margin-hjelpere. Trygg som standard (dry-run som default).

const https = require('https');
const crypto = require('crypto');

const API_URL = process.env.BINANCE_API_URL || 'https://api.binance.com';
const API_KEY =
  process.env.BINANCE_LIVE_API_KEY || process.env.BINANCE_TEST_API_KEY || '';
const API_SECRET =
  process.env.BINANCE_LIVE_SECRET_KEY || process.env.BINANCE_TEST_SECRET_KEY || '';
const RECV_WINDOW = parseInt(process.env.BINANCE_RECV_WINDOW || '5000', 10);
const MARGIN_DRY_RUN = String(process.env.MARGIN_DRY_RUN || 'true').toLowerCase() === 'true';

function hmacSign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

function doRequest(method, pathWithQuery) {
  const url = new URL(pathWithQuery, API_URL);
  const opts = {
    method,
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: { 'X-MBX-APIKEY': API_KEY }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error(
              `Binance error ${res.statusCode}: ${JSON.stringify(json)}`
            );
            err.statusCode = res.statusCode;
            err.body = json;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Hent Cross Margin-konto (samme som testet tidligere) */
async function getMarginAccount() {
  const now = Date.now();
  const q = new URLSearchParams({
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW)
  });
  const sig = hmacSign(q.toString());
  q.append('signature', sig);
  return doRequest('GET', `/sapi/v1/margin/account?${q.toString()}`);
}

/**
 * Legg inn Cross Margin-ordre.
 * sideEffectType:
 *  - 'MARGIN_BUY'  → auto-borrow ved kjøp om nødvendig
 *  - 'AUTO_REPAY'  → ved salg, auto-repay lån
 */
async function placeMarginOrder({
  symbol,
  side,                  // 'BUY' | 'SELL'
  type = 'MARKET',       // 'MARKET' | 'LIMIT' | 'STOP_LOSS_LIMIT' | ...
  quantity,              // antall base asset
  quoteOrderQty,         // alternativt: beløp i quote (USDT osv.)
  price,                 // ved LIMIT/STOP_LOSS_LIMIT
  stopPrice,             // ⬅️ viktig for STOP_LOSS_LIMIT
  timeInForce,           // f.eks. 'GTC'
  isIsolated = false,    // false = Cross Margin
  sideEffectType,        // 'MARGIN_BUY' eller 'AUTO_REPAY'
  newClientOrderId,
  newOrderRespType = 'RESULT'
}) {
  // Enkel guard så vi ikke sender tom ordre ved en feil
  if (quantity == null && quoteOrderQty == null) {
    throw new Error('placeMarginOrder: require quantity or quoteOrderQty');
  }

  const now = Date.now();
  const params = new URLSearchParams({
    symbol,
    side,
    type,
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    isIsolated: isIsolated ? 'TRUE' : 'FALSE',
    newOrderRespType
  });

  if (quantity != null) params.append('quantity', String(quantity));
  if (quoteOrderQty != null) params.append('quoteOrderQty', String(quoteOrderQty));
  if (price != null) params.append('price', String(price));
  if (stopPrice != null) params.append('stopPrice', String(stopPrice)); // ⬅️ lagt til
  if (timeInForce) params.append('timeInForce', timeInForce);
  if (sideEffectType) params.append('sideEffectType', sideEffectType);
  if (newClientOrderId) params.append('newClientOrderId', newClientOrderId);

  const signature = hmacSign(params.toString());
  params.append('signature', signature);

  const url = `/sapi/v1/margin/order?${params.toString()}`;

  if (MARGIN_DRY_RUN) {
    console.log('[MARGIN_DRY_RUN] POST', url);
    return { dryRun: true, url };
  }

  return doRequest('POST', url);
}

/** Avbryt ordre (Cross Margin) */
async function cancelMarginOrder({ symbol, orderId, origClientOrderId, isIsolated = false }) {
  const now = Date.now();
  const params = new URLSearchParams({
    symbol,
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    isIsolated: isIsolated ? 'TRUE' : 'FALSE'
  });
  if (orderId != null) params.append('orderId', String(orderId));
  if (origClientOrderId) params.append('origClientOrderId', origClientOrderId);

  const signature = hmacSign(params.toString());
  params.append('signature', signature);

  const url = `/sapi/v1/margin/order?${params.toString()}`;
  if (MARGIN_DRY_RUN) {
    console.log('[MARGIN_DRY_RUN] DELETE', url);
    return { dryRun: true, url };
  }
  return doRequest('DELETE', url);
}

/** Åpne ordre for et symbol (Cross Margin) */
async function getOpenMarginOrders({ symbol, isIsolated = false } = {}) {
  const now = Date.now();
  const params = new URLSearchParams({
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    isIsolated: isIsolated ? 'TRUE' : 'FALSE'
  });
  if (symbol) params.append('symbol', symbol);

  const signature = hmacSign(params.toString());
  params.append('signature', signature);

  const url = `/sapi/v1/margin/openOrders?${params.toString()}`;
  return doRequest('GET', url);
}

/** Lån et asset via Cross Margin */
async function borrowAsset({ asset, amount, isIsolated = false }) {
  const now = Date.now();
  const params = new URLSearchParams({
    asset,
    amount: String(amount),
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    isIsolated: isIsolated ? 'TRUE' : 'FALSE'
  });

  const sig = hmacSign(params.toString());
  params.append('signature', sig);

  const url = `/sapi/v1/margin/loan?${params.toString()}`;

  if (MARGIN_DRY_RUN) {
    console.log('[MARGIN_DRY_RUN] POST', url);
    return { dryRun: true, url };
  }

  return doRequest('POST', url);
}

/** Betal tilbake et lån via Cross Margin */
async function repayAsset({ asset, amount, isIsolated = false }) {
  const now = Date.now();
  const params = new URLSearchParams({
    asset,
    amount: String(amount),
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    isIsolated: isIsolated ? 'TRUE' : 'FALSE'
  });

  const sig = hmacSign(params.toString());
  params.append('signature', sig);

  const url = `/sapi/v1/margin/repay?${params.toString()}`;

  if (MARGIN_DRY_RUN) {
    console.log('[MARGIN_DRY_RUN] POST', url);
    return { dryRun: true, url };
  }

  return doRequest('POST', url);
}


module.exports = {
  getMarginAccount,
  placeMarginOrder,
  cancelMarginOrder,
  getOpenMarginOrders,
  borrowAsset,     // ← legg til
  repayAsset       // ← legg til
};
