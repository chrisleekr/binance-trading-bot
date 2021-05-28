const config = require('config');
const logger = require('./logger');
const TelegramBot = require('node-telegram-bot-api');

// replace the value below with the Telegram token you receive from @BotFather
const token = config.get('telegram.token');
// read the doc from https://github.com/yagop/node-telegram-bot-api to know how to catch the chatId
const chatId = config.get('telegram.chatid');

const bot = new TelegramBot(token, { polling: false });

const notifyTelegram = (message) => {
  bot.sendMessage(chatId, message,{parse_mode : "MARKDOWN"});
}

module.exports = {
  notifyTelegram
}