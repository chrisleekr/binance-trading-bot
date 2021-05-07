const axios = require('axios');
const config = require('config');
const logger = require('./logger');

/**
 * Send slack message
 *
 * @param {*} text
 */
const sendMessage = text => {
  logger.info({ tag: 'slack-send-message', text }, 'Send slack message');

  if (config.get('slack.enabled') !== true) {
    return Promise.resolve({});
  }

  return axios.post(config.get('slack.webhookUrl'), {
    channel: config.get('slack.channel'),
    username: `${config.get('slack.username')} - ${config.get('mode')}`,
    type: 'mrkdwn',
    text
  });
};

module.exports = { sendMessage };
