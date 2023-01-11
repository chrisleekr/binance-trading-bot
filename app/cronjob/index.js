const { execute: executeAlive } = require('./alive');
const { execute: executeTrailingTrade } = require('./trailingTrade');
const {
  execute: executeTrailingTradeIndicator
} = require('./trailingTradeIndicator');
const { execute: executeTradingView } = require('./tradingView');

module.exports = {
  executeAlive,
  executeTrailingTrade,
  executeTrailingTradeIndicator,
  executeTradingView
};
