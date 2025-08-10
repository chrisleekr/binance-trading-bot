const { placeMarginOrder } = require('./binance/margin');

(async () => {
  try {
    // EKSEMPEL: kjøp for 10 USDT i BTCUSDT med auto-lån ved behov (Cross Margin)
    const res = await placeMarginOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: 10,
      sideEffectType: 'MARGIN_BUY', // auto-borrow ved behov
      isIsolated: false
    });
    console.log('Dry-run OK:', res);
  } catch (err) {
    console.error('Feil i placeMarginOrder (dry-run):', err.message);
    console.error(err.body || err);
  }
  process.exit(0);
})();
