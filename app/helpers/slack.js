const axios = require('axios');
const config = require('config');
const logger = require('./logger');

/**
 * Send slack message
 *
 * @param {*} text
 */
const notifySlack = text => {
  logger.info({ tag: 'slack-send-message', text }, 'Send slack message');

  return axios.post(config.get('slack.webhookUrl'), {
    channel: config.get('slack.channel'),
    username: `${config.get('slack.username')} - ${config.get('mode')}`,
    type: 'mrkdwn',
    text
  });
};

module.exports = { notifySlack };
