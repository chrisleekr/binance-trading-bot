const { getAccountInfoFromAPI } = require('../../trailingTradeHelper/common');

/**
 * Get account info
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  data.accountInfo = await getAccountInfoFromAPI(logger);

  return data;
};

module.exports = { execute };
