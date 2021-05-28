/* istanbul ignore file */
const config = require('config');
const { messager, logger } = require('../helpers');

(async () => {
  logger.info({ messagerConfig: config.get('messager') }, 'messager config');

  const message = `${config.get('mode')} - Binance bot messager test`;

  const result = await messager.sendMessage(message);

  logger.info({ result }, 'messager result');
  process.exit(0);
})();
