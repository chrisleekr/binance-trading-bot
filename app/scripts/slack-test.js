/* istanbul ignore file */
const config = require('config');
const { slack, logger } = require('../helpers');

(async () => {
  logger.info({ slackConfig: config.get('slack') }, 'Slack config');

  const message = `${config.get('mode')} - Binance bot slack test`;

  const result = await slack.sendMessage(message);

  logger.info({ result }, 'Slack result');
  process.exit(0);
})();
