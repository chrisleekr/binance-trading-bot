/* istanbul ignore file */
const config = require('config');
const { binance, logger } = require('../helpers');

const { maskConfig } = require('../cronjob/trailingTradeHelper/util');

(async () => {
  const maskededConfig = maskConfig(config);
  logger.info({ maskededConfig }, 'Test Binance connection');

  const accountInfo = await binance.client.accountInfo();

  logger.info({ accountInfo }, 'Retrieved account information');

  process.exit(0);
})();
