const moment = require('moment');
const { binance, cache } = require('../../../helpers');

/**
 * Get account information from Binance
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;
  const {
    symbolInfo: { baseAsset, quoteAsset },
    buy: { currentPrice },
    refreshAccountInfo
  } = data;

  if (refreshAccountInfo === false) {
    logger.info('No need to refresh account information');
    return data;
  }

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

  // Get asset balances
  const baseAssetBalance = accountInfo.balances.filter(
    b => b.asset === baseAsset
  )[0] || {
    asset: baseAsset,
    free: 0,
    locked: 0,
    total: 0,
    estimatedValue: 0
  };
  const quoteAssetBalance = accountInfo.balances.filter(
    b => b.asset === quoteAsset
  )[0] || {
    asset: quoteAsset,
    free: 0,
    locked: 0
  };

  const baseAssetTotalBalance =
    parseFloat(baseAssetBalance.free) + parseFloat(baseAssetBalance.locked);

  // If this step is executed, after current price retrieved, then estimate value again.
  let baseAssetEstimatedValue = null;
  if (currentPrice) {
    baseAssetEstimatedValue = baseAssetTotalBalance * currentPrice;
  }
  // Populate data
  data.accountInfo = accountInfo;

  data.baseAssetBalance = baseAssetBalance;
  data.baseAssetBalance.total = baseAssetTotalBalance;
  if (baseAssetEstimatedValue) {
    data.baseAssetBalance.estimatedValue = baseAssetEstimatedValue;
  }
  data.baseAssetBalance.updatedAt = moment(accountInfo.updateTime).utc();

  data.quoteAssetBalance = quoteAssetBalance;

  data.refreshAccountInfo = false;
  return data;
};

module.exports = { execute };
