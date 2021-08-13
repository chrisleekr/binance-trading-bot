const _ = require('lodash');
const moment = require('moment');
const { slack } = require('../../../helpers');

const { getAPILimit } = require('../../../cronjob/trailingTradeHelper/common');

const {
  archiveSymbolGridTrade,
  deleteSymbolGridTrade
} = require('../../../cronjob/trailingTradeHelper/configuration');

const handleSymbolGridTradeDelete = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start grid trade delete');

  const { data: symbolInfo } = payload;

  const { action, symbol } = symbolInfo;

  if (action === 'archive') {
    // Archive symbol grid trade
    const archivedGridTrade = await archiveSymbolGridTrade(logger, symbol);
    logger.info({ archivedGridTrade }, 'Archived grid trade');

    // Notify slack
    if (_.isEmpty(archivedGridTrade) === false) {
      await slack.sendMessage(
        `${symbol} ${
          archivedGridTrade.profit > 0 ? 'Profit' : 'Loss'
        } (${moment().format('HH:mm:ss.SSS')}):\n` +
          `\`\`\`` +
          ` - Profit: ${archivedGridTrade.profit}\n` +
          ` - ProfitPercentage: ${archivedGridTrade.profitPercentage}\n` +
          ` - Total Buy Amount: ${archivedGridTrade.totalBuyQuoteQty}\n` +
          ` - Total Sell Amount: ${archivedGridTrade.totalSellQuoteQty}\n` +
          `\`\`\`\n` +
          `- Current API Usage: ${getAPILimit(logger)}`
      );
    }
  }

  await deleteSymbolGridTrade(logger, symbol);

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-grid-trade-delete-result' })
  );
};

module.exports = { handleSymbolGridTradeDelete };
