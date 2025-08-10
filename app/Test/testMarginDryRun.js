// app/test/testMarginDryRun.js

const {
  getMarginAccount,
  placeMarginOrder,
  cancelMarginOrder,
  borrowAsset,
  repayAsset
} = require('../binance/margin');

(async () => {
  console.log('=== Test: getMarginAccount ===');
  try {
    const account = await getMarginAccount();
    console.log('Margin Account:', JSON.stringify(account, null, 2));
  } catch (err) {
    console.error('getMarginAccount ERROR:', err.message);
  }

  console.log('\n=== Test: placeMarginOrder BUY (dry-run) ===');
  try {
    const res = await placeMarginOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty: 10,
      sideEffectType: 'MARGIN_BUY'
    });
    console.log('placeMarginOrder BUY result:', res);
  } catch (err) {
    console.error('placeMarginOrder BUY ERROR:', err.message);
  }

  console.log('\n=== Test: placeMarginOrder SELL (dry-run) ===');
  try {
    const res = await placeMarginOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 0.001,
      sideEffectType: 'AUTO_REPAY'
    });
    console.log('placeMarginOrder SELL result:', res);
  } catch (err) {
    console.error('placeMarginOrder SELL ERROR:', err.message);
  }

  console.log('\n=== Test: borrowAsset (dry-run) ===');
  try {
    const res = await borrowAsset({
      asset: 'USDT',
      amount: 10
    });
    console.log('borrowAsset result:', res);
  } catch (err) {
    console.error('borrowAsset ERROR:', err.message);
  }

  console.log('\n=== Test: repayAsset (dry-run) ===');
  try {
    const res = await repayAsset({
      asset: 'USDT',
      amount: 10
    });
    console.log('repayAsset result:', res);
  } catch (err) {
    console.error('repayAsset ERROR:', err.message);
  }

  console.log('\n=== Test: cancelMarginOrder (dry-run) ===');
  try {
    const res = await cancelMarginOrder({
      symbol: 'BTCUSDT',
      orderId: 123456789
    });
    console.log('cancelMarginOrder result:', res);
  } catch (err) {
    console.error('cancelMarginOrder ERROR:', err.message);
  }
})();
