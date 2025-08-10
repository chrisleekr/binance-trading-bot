// // app/helpers/placeOrderRouted.js
// require('dotenv').config();
// const { routeOrder } = require('./orderRouter');
// const { binance } = require('.'); // original helper (for Spot fallback)

// const isMarginMode = String(process.env.MARGIN_MODE || 'false').toLowerCase() === 'true';

// /**
//  * Drop-in erstatning for binance.client.order(payload).
//  * - Hvis MARGIN_MODE=true → rout via margin (med guard + dry-run støtte)
//  * - Ellers → kall original spot-API (som før)
//  *
//  * @param {object} payload - samsvarer med eksisterende kall i koden
//  *    { symbol, side, type, quantity, quoteOrderQty, price, timeInForce, newClientOrderId, ... }
//  */
// async function placeOrderRouted(payload) {
//   // Normaliser felter vi bryr oss om:
//   const {
//     symbol,
//     side,
//     type = 'MARKET',
//     quantity,
//     quoteOrderQty,
//     price,
//     timeInForce,
//     newClientOrderId
//   } = payload;

//   if (!isMarginMode) {
//     // Kjør som før (Spot)
//     // Viktig: behold hele payload slik eksisterende kode ikke brekker
//     return binance.client.order(payload);
//   }

//   // Margin-mode: bruk vår router (inkl. guard og dry-run)
//   const routed = await routeOrder({
//     symbol,
//     side,
//     type,
//     quantity,
//     quoteOrderQty,
//     price,
//     timeInForce,
//     newClientOrderId
//   });

//   // Hvis guard blokkerer → kast feil som fanges i eksisterende error flow
//   if (routed && routed.success === false && routed.blockedByGuard) {
//     const err = new Error('BlockedByMarginGuard');
//     err.details = routed;
//     throw err;
//   }

//   // Returner noe som ligner på spot-respons slik resten av koden forstår det
//   return routed && routed.response ? routed.response : routed;
// }

// module.exports = { placeOrderRouted };

const { marginRepay, marginOrder } = require('../exchange/binance');

async function placeOrderRouted(assetOrSymbol, side, amount, opts = {}) {
  if (side === 'REPAY') return await marginRepay(assetOrSymbol, amount);

  if (side === 'BUY' || side === 'SELL') {
    const symbol = opts.symbol || `${assetOrSymbol}${process.env.AI_TRADER_QUOTE_ASSET || 'USDT'}`;
    const type = opts.type || 'MARKET';
    const params = Object.assign({}, opts.params || {});
    // helpful defaults for cross margin
    if (!params.sideEffectType && (side === 'BUY' || side === 'SELL')) {
      // Consider AUTO_BORROW for BUY and AUTO_REPAY for SELL if you prefer; keep undefined if account has defaults
      if (opts.autoBorrow === true && side === 'BUY') params.sideEffectType = 'MARGIN_BUY';
      if (opts.autoRepay === true && side === 'SELL') params.sideEffectType = 'AUTO_REPAY';
    }
    return await marginOrder(symbol, side, amount, type, params);
  }
  throw new Error(`Ukjent ordretype: ${side}`);
}

module.exports = { placeOrderRouted };
