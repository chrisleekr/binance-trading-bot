const axios = require('axios');
const config = require('config');

/**
 * Send slack message
 *
 * @param {*} text
 */
const sendMessage = text => {
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
