const { routeOrder } = require('./helpers/orderRouter');

(async () => {
  try {
    console.log('--- TEST: BUY 10 USDT BTCUSDT (Margin expected) ---');
    const buy = await routeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: 10
    });
    console.log(JSON.stringify(buy, null, 2));

    console.log('\n--- TEST: SELL 10 USDT BTCUSDT (Margin expected) ---');
    const sell = await routeOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quoteOrderQty: 10
    });
    console.log(JSON.stringify(sell, null, 2));
  } catch (e) {
    console.error('Test feilet:', e.message, e.body || '');
    process.exit(1);
  }
  process.exit(0);
})();
