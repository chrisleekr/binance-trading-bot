const moment = require('moment-timezone');
const config = require('config');
const aliveHelper = require('./alive/helper');
const { slack } = require('../helpers');

const execute = async logger => {
  logger.info('Alive: Notify balance');

  try {
    // 1. Get account info
    const accountInfo = await aliveHelper.getAccountInfo(logger);

    let message = '*Account Balance:*\n```';

    accountInfo.balances.forEach(b => {
      message += `- ${b.asset}: Free ${(+b.free).toFixed(
        3
      )}, Locked ${(+b.locked).toFixed(3)}\n`;
    });
    message += '```\n';
    message += `_Last Updated: ${moment(accountInfo.updateTime, 'x')
      .tz(config.get('tz'))
      .format('YYYY-MM-DD HH:mm:ss')} (${config.get('tz')})_`;

    slack.sendMessage(message);
  } catch (e) {
    logger.error(e, 'Execution failed.');
    slack.sendMessage(`Execution failed\n\`\`\`${e.message}\`\`\``);
  }
};

module.exports = { execute };
