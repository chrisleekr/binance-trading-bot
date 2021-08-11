const { handleAuth } = require('./auth');
const {
  handleGridTradeArchiveGetBySymbol
} = require('./grid-trade-archive-get-by-symbol');
const {
  handleGridTradeArchiveGetByQuoteAsset
} = require('./grid-trade-archive-get-by-quote-asset');
const { handleGridTradeArchiveDelete } = require('./grid-trade-archive-delete');
const { handle404 } = require('./404');

module.exports = {
  handleAuth,
  handleGridTradeArchiveGetBySymbol,
  handleGridTradeArchiveGetByQuoteAsset,
  handleGridTradeArchiveDelete,
  handle404
};
