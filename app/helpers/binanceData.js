const axios = require('axios');
const BASE = 'https://api.binance.com';

async function getKlines(symbol, interval, limit) {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  return data.map(k => ({
    openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6]
  }));
}

async function getPrice(symbol) {
  const url = `${BASE}/api/v3/ticker/price?symbol=${symbol}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  return +data.price;
}

module.exports = { getKlines, getPrice };
