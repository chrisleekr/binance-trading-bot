const moment = require('moment');

/**
 * Get account information from Binance
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;
  const {
    accountInfo,
    symbolInfo: { baseAsset, quoteAsset },
    buy: { currentPrice }
  } = data;

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
  let baseAssetEstimatedValue = 0;
  if (currentPrice) {
    baseAssetEstimatedValue = baseAssetTotalBalance * currentPrice;
  }
  // Populate data
  data.accountInfo = accountInfo;

  data.baseAssetBalance = baseAssetBalance;
  data.baseAssetBalance.total = baseAssetTotalBalance;
  data.baseAssetBalance.estimatedValue = baseAssetEstimatedValue;
  data.baseAssetBalance.updatedAt = moment(accountInfo.updateTime).utc();

  data.quoteAssetBalance = quoteAssetBalance;

  logger.info({ quoteAssetBalance, baseAssetBalance }, 'Balances');
  return data;
};

module.exports = { execute };
