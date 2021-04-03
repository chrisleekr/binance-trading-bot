const { binance } = require('../../helpers');

/**
 * Get balance from Binance
 *
 * @param {*} logger
 */
const getAccountInfo = async logger => {
  logger.info({ function: 'accountInfo' }, 'Retrieving accountInfo from API');
  const accountInfo = await binance.client.accountInfo();

  accountInfo.balances = accountInfo.balances.reduce((acc, b) => {
    const balance = b;
    if (+balance.free > 0 || +balance.locked > 0) {
      acc.push(balance);
    }

    return acc;
  }, []);

  logger.info({ accountInfo }, 'Retrieved account information');
  return accountInfo;
};

module.exports = { getAccountInfo };
