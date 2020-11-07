const bbandsHelper = require('./bbands/helper');
const { slack } = require('../helpers');

const execute = async logger => {
  logger.info('Trade: Bollinger Bands');

  try {
    // 1. Get indicators
    const indicators = await bbandsHelper.getIndicators(logger);
    logger.info({ indicators }, 'Retrieved indicator.');

    // 2. Determine actions
    const tradeAction = bbandsHelper.determineAction(logger, indicators);

    logger.info({ tradeAction }, 'Determined action.');

    // 3. Get order result

    if (tradeAction !== 'hold') {
      // 3-1. Place buy order
      const orderResult = await bbandsHelper.placeOrder(logger, tradeAction, 100, indicators);
      logger.info({ orderResult }, 'Retrieved order result.');
    } else {
      logger.info({}, 'HOLD!');
    }
  } catch (e) {
    logger.error(e, 'Execution failed.');
    slack.sendMessage(`Execution failed\n\`\`\`${e.message}\`\`\``);
  }
};

module.exports = { execute };
