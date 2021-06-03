const _ = require('lodash');
const moment = require('moment');

const { cache, PubSub } = require('../../../helpers');

const { getAccountInfoFromAPI } = require('../../trailingTradeHelper/common');

const isAccountInfoChanged = async (
  logger,
  { oldAccountInfo, accountInfo }
) => {
  if (_.isEmpty(oldAccountInfo)) {
    logger.info('Account information is not cached yet. Skip checking changes');
    return false;
  }

  const currentSymbols = accountInfo.balances.reduce((acc, b) => {
    acc.push(b.asset);
    return acc;
  }, []);

  const oldSymbols = oldAccountInfo.balances.reduce((acc, b) => {
    acc.push(b.asset);
    return acc;
  }, []);

  return !_.isEqual(currentSymbols, oldSymbols);
};

/**
 * Get account info
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    globalConfiguration: {
      system: { refreshAccountInfoPeriod }
    }
  } = data;

  // Binance API weight for account info should be 10 for each request.
  // However, sometimes Binance changes API weight to 20 for some reason.
  // To avoid issue, getting account info will be done every 2 seconds.
  const currentSecond = moment().format('ss');

  if (currentSecond % refreshAccountInfoPeriod !== 0) {
    logger.info({ currentSecond }, 'Skipping to get account info');
    return data;
  }

  const oldAccountInfo =
    JSON.parse(await cache.hget('trailing-trade-common', 'account-info')) || {};

  const accountInfo = await getAccountInfoFromAPI(logger);

  await cache.hset(
    'trailing-trade-common',
    `account-info`,
    JSON.stringify(accountInfo)
  );

  // Determine to reset binance websocket
  if (await isAccountInfoChanged(logger, { oldAccountInfo, accountInfo })) {
    PubSub.publish('reset-binance-websocket', true);
  }

  data.accountInfo = accountInfo;
  return data;
};

module.exports = { execute };
