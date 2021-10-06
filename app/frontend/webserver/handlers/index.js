const { handleAuth } = require('./auth');
const { handleGridTradeArchiveGet } = require('./grid-trade-archive-get');
const { handleGridTradeArchiveDelete } = require('./grid-trade-archive-delete');
const { handleClosedTradesSetPeriod } = require('./closed-trades-set-period');
const { handle404 } = require('./404');
const { handleStatus } = require('./status');

const setHandlers = async (logger, app, { loginLimiter }) => {
  await handleAuth(logger, app, { loginLimiter });
  await handleGridTradeArchiveGet(logger, app);
  await handleGridTradeArchiveDelete(logger, app);
  await handleClosedTradesSetPeriod(logger, app);
  await handleStatus(logger, app);
  await handle404(logger, app);
};

module.exports = {
  setHandlers
};
