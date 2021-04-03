const {
  getGlobalConfiguration
} = require('../../trailingTradeHelper/configuration');

/**
 * Get global configuration
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  // Get global configuration
  data.globalConfiguration = await getGlobalConfiguration(logger);

  return data;
};

module.exports = { execute };
