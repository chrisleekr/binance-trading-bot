const { execute: executeAlive } = require('./alive');
const { execute: executeTrailingTrade } = require('./trailingTrade');

module.exports = {
  executeAlive,
  executeTrailingTrade
};
