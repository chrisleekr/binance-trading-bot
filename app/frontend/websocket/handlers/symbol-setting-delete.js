const _ = require('lodash');
const {
  deleteSymbolConfiguration
} = require('../../../cronjob/trailingTradeHelper/configuration');
const queue = require('../../../cronjob/trailingTradeHelper/queue');

const handleSymbolSettingDelete = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start symbol setting delete');

  const { data: symbolInfo } = payload;

  const { symbol } = symbolInfo;

  const deleteSymbolConfigurationFn = async () => {
    await deleteSymbolConfiguration(logger, symbol);
  };

  await queue.execute(
    logger,
    symbol,
    {
      preprocessFn: deleteSymbolConfigurationFn
    },
    {
      correlationId: _.get(logger, 'fields.correlationId', '')
    }
  );

  ws.send(
    JSON.stringify({ result: true, type: 'symbol-setting-delete-result' })
  );
};

module.exports = { handleSymbolSettingDelete };
