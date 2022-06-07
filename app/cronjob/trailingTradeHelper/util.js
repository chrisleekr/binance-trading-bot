const _ = require('lodash');

/**
 * Calculate round down
 *
 * @param {*} number
 * @param {*} decimals
 */
const roundDown = (number, decimals) =>
  // eslint-disable-next-line no-restricted-properties
  Math.floor(number * 10 ** decimals) / 10 ** decimals;

/**
 * Mask important config key
 *
 * @param {*} orgConfig
 * @returns
 */
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

module.exports = {
  roundDown,
  maskConfig
};
