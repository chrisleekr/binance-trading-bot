const { binance, cache } = require('../../../helpers');

/**
 * Get account information from Binance
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const accountInfo = await binance.client.accountInfo();

  accountInfo.balances = accountInfo.balances.reduce((acc, b) => {
    const balance = b;
    if (+balance.free > 0 || +balance.locked > 0) {
      acc.push(balance);
    }

    return acc;
  }, []);

  logger.info({ accountInfo }, 'Retrieved account information');

  cache.hset(
    'trailing-trade-common',
    `account-info`,
    JSON.stringify(accountInfo)
  );

  data.accountInfo = accountInfo;

  return data;
};

module.exports = { execute };
