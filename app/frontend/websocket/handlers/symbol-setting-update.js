const _ = require('lodash');
const {
  getSymbolConfiguration,
  saveSymbolConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');
const queue = require('../../../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../../../cronjob/index');

const handleSymbolSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol setting update');

  const { data: symbolInfo } = payload;

  const { symbol, configuration: newSymbolConfiguration } = symbolInfo;

  // Get current symbol configuration
  const symbolConfiguration = await getSymbolConfiguration(logger, symbol);
  logger.info({ symbolConfiguration }, 'Current symbol configuration');

  const symbolConfigurationFn = async () => {
    // Get only editable params
    const { candles, buy, sell, botOptions } = newSymbolConfiguration;
    symbolConfiguration.candles = candles;

    // We do not want to save executed/executedOrder as it will be processed in the configuration.
    buy.gridTrade = buy.gridTrade.map(b =>
      _.omit(b, 'executed', 'executedOrder')
    );
    sell.gridTrade = sell.gridTrade.map(b =>
      _.omit(b, 'executed', 'executedOrder')
    );

    symbolConfiguration.buy = _.omit(
      buy,
      'currentGridTradeIndex',
      'currentGridTrade'
    );
    symbolConfiguration.sell = _.omit(
      sell,
      'currentGridTradeIndex',
      'currentGridTrade'
    );
    symbolConfiguration.botOptions = botOptions;

    logger.info({ symbolConfiguration }, 'Updated symbol configuration');

    await saveSymbolConfiguration(logger, symbol, symbolConfiguration);
  };

  queue.execute(logger, symbol, {
    correlationId: _.get(logger, 'fields.correlationId', ''),
    preprocessFn: symbolConfigurationFn,
    processFn: executeTrailingTrade
  });

  ws.send(
    JSON.stringify({
      result: true,
      symbolConfiguration,
      type: 'symbol-setting-update-result'
    })
  );
};

module.exports = { handleSymbolSettingUpdate };
