const { checkMarginHealth } = require('./binance/marginGuard');

(async () => {
  try {
    const res = await checkMarginHealth();
    console.log(JSON.stringify({
      ok: res.ok,
      level: res.level,
      borrowRatio: res.borrowRatio,
      advice: res.advice,
      snapshot: res.snapshot
    }, null, 2));
  } catch (e) {
    console.error('Guard failed:', e.message, e.body || '');
    process.exit(1);
  }
  process.exit(0);
})();
