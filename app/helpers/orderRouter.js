// app/helpers/orderRouter.js
require('dotenv').config();

const { placeMarginOrder } = require('../binance/margin');
const { checkMarginHealth } = require('../binance/marginGuard');

// ⚠️ Hvis du allerede har en spot-order-funksjon i prosjektet,
// kan du importere den her for fallback når MARGIN_MODE !== 'true'.
// For nå lager vi en NOOP-spot for testing:
async function placeSpotOrder(order) {
  // Her ville du kalt eksisterende spot-order-flyt i boten.
  // Midlertidig: bare logg hva vi ville gjort.
  console.log('[SPOT_DRY_RUN] placeSpotOrder', order);
  return { dryRun: true, mode: 'spot', order };
}

function normalizeOrder(input) {
  // Forenklet validering/normalisering
  const { symbol, side } = input;
  if (!symbol || !side) throw new Error('Order mangler symbol/side');

  const order = {
    symbol: symbol.toUpperCase(),
    side: side.toUpperCase(),
    type: (input.type || 'MARKET').toUpperCase(),
    quoteOrderQty: input.quoteOrderQty != null ? Number(input.quoteOrderQty) : undefined,
    quantity: input.quantity != null ? Number(input.quantity) : undefined,
    price: input.price != null ? Number(input.price) : undefined,
    timeInForce: input.timeInForce,
    isIsolated: false, // Cross Margin
    newClientOrderId: input.newClientOrderId
  };

  if (!order.quantity && !order.quoteOrderQty) {
    throw new Error('Order må ha quantity eller quoteOrderQty');
  }
  return order;
}

async function routeOrder(raw) {
  const isMargin = String(process.env.MARGIN_MODE || 'false').toLowerCase() === 'true';
  const order = normalizeOrder(raw);

  if (!isMargin) {
    // Kjør spot-flyt (her: dry-run / logg)
    return placeSpotOrder(order);
  }

  // Margin-mode: kjør guard først
  const guard = await checkMarginHealth();
  if (!guard.ok) {
    console.error('[MARGIN_GUARD] Blokkerer ordre pga. risiko:', guard.advice);
    return { success: false, blockedByGuard: true, advice: guard.advice, guard };
  }

  // Sett riktig sideEffectType for Cross Margin
  const sideEffectType = order.side === 'BUY' ? 'MARGIN_BUY' : 'AUTO_REPAY';

  // Send margin-ordre (respekterer MARGIN_DRY_RUN=true)
  const res = await placeMarginOrder({
    ...order,
    sideEffectType,
    isIsolated: false
  });

  return { success: true, mode: 'margin', guard, response: res };
}

module.exports = { routeOrder };
