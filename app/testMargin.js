const { getMarginAccount } = require('./clients/binanceMargin');

(async () => {
  try {
    const account = await getMarginAccount();
    console.log('Margin account data:');
    console.log(JSON.stringify(account, null, 2));
  } catch (err) {
    console.error('Error fetching margin account:', err.message);
    console.error(err.body || err);
  }
  process.exit(0);
})();
