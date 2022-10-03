const { handleAuth } = require('./auth');
const { handleGridTradeArchiveGet } = require('./grid-trade-archive-get');
const { handleGridTradeArchiveDelete } = require('./grid-trade-archive-delete');
const { handleClosedTradesSetPeriod } = require('./closed-trades-set-period');
const { handleGridTradeLogsGet } = require('./grid-trade-logs-get');
const { handleGridTradeLogsExport } = require('./grid-trade-logs-export');
const { handleStatus } = require('./status');
const { handleSymbolDelete } = require('./symbol-delete');
const { handleBackupGet } = require('./backup-get');
const { handleRestorePost } = require('./restore-post');
const { handle404 } = require('./404');

const setHandlers = async (logger, app, { loginLimiter }) => {
  await handleAuth(logger, app, { loginLimiter });
  await handleGridTradeArchiveGet(logger, app);
  await handleGridTradeArchiveDelete(logger, app);
  await handleClosedTradesSetPeriod(logger, app);
  await handleGridTradeLogsGet(logger, app);
  await handleGridTradeLogsExport(logger, app);
  await handleStatus(logger, app);
  await handleSymbolDelete(logger, app);
  await handleBackupGet(logger, app);
  await handleRestorePost(logger, app);
  await handle404(logger, app);
};

module.exports = {
  setHandlers
};
