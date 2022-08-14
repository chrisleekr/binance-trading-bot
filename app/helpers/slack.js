const _ = require('lodash');
const moment = require('moment');
const axios = require('axios');
const config = require('config');
const logger = require('./logger');

// This variable will store last message per symbol to avoid saving the duplicated message.
const lastMessages = {};

/**
 * Send slack message
 *
 * @param {*} text
 */
const sendMessage = (text, params = {}) => {
  if (_.get(params, 'symbol', '') !== '') {
    if (_.get(lastMessages, `${params.symbol}.message`, '') === text) {
      return Promise.resolve({});
    }

    lastMessages[params.symbol] = { message: text };
  }

  let formattedText = `(${moment().format('HH:mm:ss.SSS')}) ${text}`;
  if (params.apiLimit) {
    formattedText += `\n- Current API Usage: ${params.apiLimit}`;
  }

  logger.info(
    { tag: 'slack-send-message', formattedText },
    'Send slack message'
  );

  if (config.get('slack.enabled') !== true) {
    return Promise.resolve({});
  }

  return axios.post(config.get('slack.webhookUrl'), {
    channel: config.get('slack.channel'),
    username: `${config.get('slack.username')} - ${config.get('mode')}`,
    type: 'mrkdwn',
    text: formattedText
  });
};

module.exports = { sendMessage };
