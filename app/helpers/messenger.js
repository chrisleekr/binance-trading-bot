/* eslint-disable prefer-template */
/* eslint-disable no-useless-concat */
const telegram = require('./telegram');
const slack = require('./slack');

let globalConfiguration;

const updateConfiguration = async newConfig => {
  globalConfiguration = newConfig;
};

/**
 * Send slack message
 *
 * @param {*} text
 */
const sendMessage = async (symbol = null, lastOrder = null, action) => {
  let message = 'message not set';
  let quantity = 'quantity not set';
  let price = 'price not set';
  if (lastOrder != null) {
    quantity = lastOrder.quantity;
    price = lastOrder.price;
  }
  const { language } = globalConfiguration.botOptions;
  const { send_message } = require(`../../public/${language}.json`);

  switch (action) {
    case 'NO_CANDLE_RECEIVED':
      message =
        send_message.no_candle[1] + symbol + '\n' + send_message.no_candle[2];
      break;

    case 'BALANCE_INFO':
      message = symbol;
      break;

    case 'PLACE_BUY':
      message =
        send_message.place_buy[1] +
        ' 💵\n' +
        send_message.place_buy[2] +
        ': ' +
        symbol +
        '\n' +
        send_message.place_buy[3] +
        quantity +
        '\n' +
        send_message.place_buy[4] +
        price;
      break;

    case 'PLACE_BUY_DONE':
      message =
        send_message.place_buy_done[1] +
        '✔\n' +
        send_message.place_buy_done[2] +
        ': ' +
        symbol;
      break;

    case 'PLACE_SELL':
      message =
        send_message.place_sell[1] +
        ' 💵\n' +
        send_message.place_sell[2] +
        ': ' +
        symbol +
        '\n' +
        send_message.place_sell[3] +
        quantity +
        '\n' +
        send_message.place_sell[4] +
        price;
      break;

    case 'PLACE_SELL_DONE':
      message =
        send_message.place_sell_done[1] +
        '✔\n' +
        send_message.place_sell_done[2] +
        ': ' +
        symbol;
      break;

    case 'CHECK_BUY':
      message = send_message.check_buy + symbol + ' ... 🔍';
      break;

    case 'CHECK_SELL':
      message = send_message.check_sell + symbol + ' ... 🔍';
      break;

    case 'BUY_CONFIRMED':
      message =
        send_message.buy_confirmed[1] +
        '✔\n' +
        send_message.buy_confirmed[2] +
        ': ' +
        symbol;
      break;

    case 'SELL_CONFIRMED':
      message =
        send_message.sell_confirmed[1] +
        '✔\n' +
        send_message.sell_confirmed[2] +
        ': ' +
        symbol;
      break;

    case 'CANCEL_BUY':
      message =
        send_message.cancel_buy[1] + symbol + send_message.cancel_buy[2];
      break;

    case 'CANCEL_SELL':
      message =
        send_message.cancel_sell[1] + symbol + send_message.cancel_sell[2];
      break;

    case 'SELL_STOP_LOSS':
      message =
        send_message.sell_stop_loss[1] +
        symbol +
        send_message.sell_stop_loss[2];
      break;

    case 'REMOVE_LAST_BUY':
      message = send_message.remove_last_buy_from + symbol;
      break;

    case 'LINK':
      message = `Bot *link*: ${symbol}`;
      break;

    default:
      message = send_message.default_warning + `\n${action}\n${symbol}`;
      break;
  }

  if (globalConfiguration.botOptions.slack === true) {
    slack.notifySlack(message);
  }
  if (globalConfiguration.botOptions.telegram === true) {
    telegram.notifyTelegram(message);
  }
};

const errorMessage = text => {
  if (globalConfiguration.botOptions.slack === true) {
    slack.notifySlack(text);
  }
  if (globalConfiguration.botOptions.telegram === true) {
    telegram.notifyTelegram(text);
  }
};

module.exports = { sendMessage, errorMessage, updateConfiguration };
