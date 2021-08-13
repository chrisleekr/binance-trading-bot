/* eslint-disable prefer-destructuring */
const { getSymbolInfo } = require('../../trailingTradeHelper/common');

/**
 * Get symbol info from Binance/cache
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  // Retrieve symbol info
  const symbolInfo = await getSymbolInfo(logger, symbol);

  data.symbolInfo = symbolInfo;

  return data;
};

module.exports = { execute };
