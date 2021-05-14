/* istanbul ignore file */
const _ = require('lodash');
const config = require('config');
const { binance, logger } = require('../helpers');

const maskConfig = orgConfig => {
  const maskedConfig = _.cloneDeep(orgConfig);

  const maskedPaths = [
    'binance.live.apiKey',
    'binance.live.secretKey',
    'binance.test.apiKey',
    'binance.test.secretKey'
  ];

  maskedPaths.forEach(path => {
    if (_.get(maskedConfig, path, '') !== '') {
      _.set(maskedConfig, path, '<masked>');
    }
  });

  return maskedConfig;
};

(async () => {
  const maskededConfig = maskConfig(config);
  logger.info({ maskededConfig }, 'Test Binance connection');

  const accountInfo = await binance.client.accountInfo();

  logger.info({ accountInfo }, 'Retrieved account information');

  process.exit(0);
})();
