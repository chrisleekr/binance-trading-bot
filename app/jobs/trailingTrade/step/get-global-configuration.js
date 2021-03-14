const { getConfiguration } = require('../configuration');

/**
 * Get global configuration
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  // Get global configuration
  data.globalConfiguration = await getConfiguration(logger);

  return data;
};

module.exports = { execute };
