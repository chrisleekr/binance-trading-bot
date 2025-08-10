// app/helpers/cancelOrderRouted.js
require('dotenv').config();
const { cancelMarginOrder } = require('../binance/margin');
const { binance } = require('../helpers');

const isMarginMode = String(process.env.MARGIN_MODE || 'false').toLowerCase() === 'true';

/**
 * Drop-in erstatning for binance.client.cancelOrder({...})
 * Støtter både spot (fallback) og cross margin (via /sapi).
 */
async function cancelOrderRouted({ symbol, orderId, origClientOrderId, isIsolated = false }) {
  if (!isMarginMode) {
    // Spot-fallback: behold original oppførsel
    return binance.client.cancelOrder({ symbol, orderId, origClientOrderId });
  }

  // Cross Margin
  return cancelMarginOrder({ symbol, orderId, origClientOrderId, isIsolated });
}

module.exports = { cancelOrderRouted };
