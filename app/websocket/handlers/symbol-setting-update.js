const {
  getSymbolConfiguration,
  saveSymbolConfiguration
} = require('../../jobs/simpleStopChaser/helper');

const handleSymbolSettingUpdate = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol setting update');

  const { data: symbolInfo } = payload;

  const { symbol, configuration: newSymbolConfiguration } = symbolInfo;

  // Get current symbol configuration
  const symbolConfiguration = await getSymbolConfiguration(logger, symbol);
  logger.info({ symbolConfiguration }, 'Current symbol configuration');

  // Get only editable params
  const {
    candles,
    maxPurchaseAmount,
    stopLossLimit,
    buy,
    sell
  } = newSymbolConfiguration;
  symbolConfiguration.candles = candles;
  symbolConfiguration.maxPurchaseAmount = maxPurchaseAmount;
  symbolConfiguration.stopLossLimit = stopLossLimit;
  symbolConfiguration.buy = buy;
  symbolConfiguration.sell = sell;

  logger.info({ symbolConfiguration }, 'Updated symbol configuration');

  await saveSymbolConfiguration(logger, symbol, symbolConfiguration);

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-setting-update-result' })
  );
};

module.exports = { handleSymbolSettingUpdate };
