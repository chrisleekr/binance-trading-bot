// app/clients/binanceMargin.js
// Minimal Binance Cross Margin-klient (kun lestekall foreløpig).
// Påvirker ikke eksisterende Spot-flyt før vi kobler den inn.

const https = require('https');
const crypto = require('crypto');

const API_URL = process.env.BINANCE_API_URL || 'https://api.binance.com';
const API_KEY =
  process.env.BINANCE_LIVE_API_KEY || process.env.BINANCE_TEST_API_KEY || '';
const API_SECRET =
  process.env.BINANCE_LIVE_SECRET_KEY || process.env.BINANCE_TEST_SECRET_KEY || '';
const RECV_WINDOW = parseInt(process.env.BINANCE_RECV_WINDOW || '5000', 10);

function hmacSign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

function doRequest(method, pathWithQuery, body = null) {
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
          reject(
            new Error(`Failed to parse response (${res.statusCode}): ${data}`)
          );
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Public ping/server time (Spot) ---
async function getServerTime() {
  return doRequest('GET', '/api/v3/time');
}

// --- Margin account info (Cross/Isolated via SAPI) ---
async function getMarginAccount(params = {}) {
  const now = Date.now();
  const q = new URLSearchParams({
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    ...params
  });
  const sig = hmacSign(q.toString());
  q.append('signature', sig);
  return doRequest('GET', `/sapi/v1/margin/account?${q.toString()}`);
}

// Eksempel på hvordan vi senere vil sende ordre (ikke brukt ennå):
async function postMarginOrder({
  symbol,
  side,
  type,
  quantity,
  price,
  isIsolated = false,
  timeInForce,
  newClientOrderId,
  quoteOrderQty
}) {
  const now = Date.now();
  const payload = new URLSearchParams({
    symbol,
    side,
    type,
    timestamp: String(now),
    recvWindow: String(RECV_WINDOW),
    isIsolated: isIsolated ? 'TRUE' : 'FALSE'
  });

  if (quantity != null) payload.append('quantity', String(quantity));
  if (price != null) payload.append('price', String(price));
  if (timeInForce) payload.append('timeInForce', timeInForce);
  if (newClientOrderId) payload.append('newClientOrderId', newClientOrderId);
  if (quoteOrderQty != null)
    payload.append('quoteOrderQty', String(quoteOrderQty));

  const sig = hmacSign(payload.toString());
  payload.append('signature', sig);

  return doRequest('POST', `/sapi/v1/margin/order?${payload.toString()}`);
}

module.exports = {
  getServerTime,
  getMarginAccount,
  postMarginOrder
};
