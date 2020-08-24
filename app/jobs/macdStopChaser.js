const macdStopChaserHelper = require('./macdStopChaser/helper');
const { slack } = require('../helpers');

const execute = async logger => {
  logger.info('Trade: MACD Stop-Chasing');

  try {
    // 1. Get indicators
    const indicators = await macdStopChaserHelper.getIndicators(logger);

    // 2. Determine actions
    const tradeActionResult = await macdStopChaserHelper.determineAction(logger, indicators);
    logger.info({ tradeActionResult }, 'Determined action.');

    // 3. Place order based on MACD signal
    let orderResult = {};
    if (tradeActionResult.action === 'buy') {
      slack.sendMessage(`Signal: *BUY*
      - Action Result: \`\`\`${JSON.stringify(tradeActionResult, undefined, 2)}\`\`\`
      `);
      orderResult = await macdStopChaserHelper.placeOrder(logger, 'buy', 100, indicators);
    } else if (tradeActionResult.action === 'sell') {
      logger.info(`Got sell signal, but do nothing. Never lose money.`);
      // slack.sendMessage(`Signal: *SELL*
      // - Action Result: \`\`\`${JSON.stringify(tradeActionResult, undefined, 2)}\`\`\`
      // `);
      // orderResult = await macdStopChaserHelper.placeOrder(logger, 'sell', 100, indicators);
    } else {
      orderResult = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
    }

    logger.info({ orderResult }, 'Retrieved order result.');
  } catch (e) {
    logger.error(e, 'Execution failed.');
    slack.sendMessage(`Execution failed\n\`\`\`${e.message}\`\`\``);
  }
};

module.exports = { execute };
