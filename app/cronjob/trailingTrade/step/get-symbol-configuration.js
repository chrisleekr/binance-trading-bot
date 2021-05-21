const { getConfiguration } = require('../../trailingTradeHelper/configuration');

/**
 * Get symbol configuration
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;
  // Get global configuration
  data.symbolConfiguration = await getConfiguration(logger, symbol);

  return data;
};

module.exports = { execute };
