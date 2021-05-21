const { execute: executeAlive } = require('./alive');
const { execute: executeTrailingTrade } = require('./trailingTrade');
const {
  execute: executeTrailingTradeIndicator
} = require('./trailingTradeIndicator');

module.exports = {
  executeAlive,
  executeTrailingTrade,
  executeTrailingTradeIndicator
};
