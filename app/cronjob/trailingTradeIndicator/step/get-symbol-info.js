const { getSymbolInfo } = require('../../trailingTradeHelper/common');
/**
 * Get symbol info
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  data.symbolInfo = await getSymbolInfo(logger, symbol);

  return data;
};

module.exports = { execute };
