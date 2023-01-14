const _ = require('lodash');
const { slack } = require('../../../helpers');

const { getAPILimit } = require('../../../cronjob/trailingTradeHelper/common');

const {
  archiveSymbolGridTrade,
  deleteSymbolGridTrade
} = require('../../../cronjob/trailingTradeHelper/configuration');

const queue = require('../../../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../../../cronjob/index');

const handleSymbolGridTradeDelete = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start grid trade delete');

  const { data: symbolInfo } = payload;

  const { action, symbol } = symbolInfo;

  const deleteSymbolGridTradeFn = async () => {
    if (action === 'archive') {
      // Archive symbol grid trade
      const archivedGridTrade = await archiveSymbolGridTrade(logger, symbol);
      logger.info({ archivedGridTrade }, 'Archived grid trade');

      // Notify slack
      if (_.isEmpty(archivedGridTrade) === false) {
        slack.sendMessage(
          `*${symbol}* ${archivedGridTrade.profit > 0 ? 'Profit' : 'Loss'}:\n` +
            `\`\`\`` +
            ` - Profit: ${archivedGridTrade.profit}\n` +
            ` - Profit Percentage: ${archivedGridTrade.profitPercentage}\n` +
            ` - Total Buy Amount: ${archivedGridTrade.totalBuyQuoteQty}\n` +
            ` - Total Sell Amount: ${archivedGridTrade.totalSellQuoteQty}\n` +
            `\`\`\``,
          { symbol, apiLimit: getAPILimit(logger) }
        );
      }
    }

    await deleteSymbolGridTrade(logger, symbol);
  };

  queue.execute(logger, symbol, {
    correlationId: _.get(logger, 'fields.correlationId', ''),
    preprocessFn: deleteSymbolGridTradeFn,
    processFn: executeTrailingTrade
  });

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-grid-trade-delete-result' })
  );
};

module.exports = { handleSymbolGridTradeDelete };
