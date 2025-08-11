
// app/helpers/placeOrderRouted.js
// Ruter ordre til Cross Margin API med riktig sideEffectType og felter.
// Forutsetter at app/binance/margin.js eksporterer:
//   getMarginAccount, placeMarginOrder, cancelMarginOrder, getOpenMarginOrders, borrowAsset, repayAsset

const {
  placeMarginOrder
} = require('../binance/margin');

function toUpperSafe(v) {
  return (v == null ? '' : String(v)).toUpperCase();
}

function normalizeSymbol(s) {
  const sym = String(s || '').trim().toUpperCase();
  if (!sym) throw new Error('placeOrderRouted: symbol mangler');
  // Her kunne vi validert mot en whitelist, men lar det være generisk.
  return sym;
}

/**
 * placeOrderRouted(input)
 * input:
 *  - symbol: 'BTCUSDC' (required)
 *  - side: 'BUY' | 'SELL' (required)
 *  - type: 'MARKET' | 'LIMIT' | 'STOP_LOSS_LIMIT' ... (default 'MARKET')
 *  - quantity: number (base qty)  | eller |
 *  - quoteOrderQty: number (beløp i quote)
 *  - price?: number               (på LIMIT/STOP_LOSS_LIMIT)
 *  - stopPrice?: number           (på STOP_LOSS_LIMIT)
 *  - timeInForce?: 'GTC' | 'IOC' | 'FOK' (på LIMIT/STOP_LOSS_LIMIT; default 'GTC')
 *  - isIsolated?: boolean (default false = Cross)
 *  - newClientOrderId?: string
 *  - newOrderRespType?: 'ACK' | 'RESULT' (default 'RESULT')
 */
async function placeOrderRouted(input = {}) {
  const symbol = normalizeSymbol(input.symbol);
  const side = toUpperSafe(input.side);
  if (side !== 'BUY' && side !== 'SELL') {
    throw new Error(`placeOrderRouted: side må være BUY eller SELL, fikk "${input.side}"`);
  }

  const type = toUpperSafe(input.type || 'MARKET');

  // Må ha enten quantity eller quoteOrderQty
  const hasQty = input.quantity != null;
  const hasQuote = input.quoteOrderQty != null;
  if (!hasQty && !hasQuote) {
    throw new Error('placeOrderRouted: krever quantity eller quoteOrderQty');
  }

  // For limit/stop-limit krever vi pris og TIF, default GTC
  let timeInForce = input.timeInForce;
  if ((type === 'LIMIT' || type === 'STOP_LOSS_LIMIT')) {
    if (input.price == null) {
      throw new Error(`placeOrderRouted: type=${type} krever "price"`);
    }
    if (!timeInForce) timeInForce = 'GTC';
  }

  // sideEffectType: BUY => MARGIN_BUY (auto-borrow), SELL => AUTO_REPAY
  const sideEffectType = side === 'BUY' ? 'MARGIN_BUY' : 'AUTO_REPAY';

  const params = {
    symbol,
    side,
    type,
    isIsolated: !!input.isIsolated,        // false = Cross (vår default)
    sideEffectType,
    newClientOrderId: input.newClientOrderId,
    newOrderRespType: input.newOrderRespType || 'RESULT'
  };

  if (hasQty) params.quantity = input.quantity;
  if (hasQuote) params.quoteOrderQty = input.quoteOrderQty;
  if (input.price != null) params.price = input.price;
  if (input.stopPrice != null) params.stopPrice = input.stopPrice;
  if (timeInForce) params.timeInForce = timeInForce;

  // Kall Binance Cross Margin-ordre
  const res = await placeMarginOrder(params);

  return {
    ok: true,
    request: params,
    response: res
  };
}

module.exports = { placeOrderRouted };
