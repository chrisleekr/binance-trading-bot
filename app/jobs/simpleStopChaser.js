const config = require('config');
const { v4: uuidv4 } = require('uuid');
const helper = require('./simpleStopChaser/helper');
const { slack, cache } = require('../helpers');

const determineNextSymbol = async (symbols, logger) => {
  const cachedLastSymbol = await cache.get('simple-stop-chaser-last-symbol');

  logger.info({ cachedLastSymbol }, 'Cached last symbol');
  let currentSymbol = symbols[0];
  if (cachedLastSymbol) {
    const cachedSymbolIndex = symbols.indexOf(cachedLastSymbol);
    logger.info({ cachedSymbolIndex }, 'Found symbol index');
    currentSymbol = symbols[cachedSymbolIndex + 1] || symbols[0];
  }

  logger.info({ currentSymbol }, 'Determined current symbol');
  await cache.set('simple-stop-chaser-last-symbol', currentSymbol);
  return currentSymbol;
};

const execute = async logger => {
  logger.info('Trade: Simple Stop-Chasing');
  const simpleStopChaser = config.get('jobs.simpleStopChaser');
  const { symbols } = simpleStopChaser;

  logger.info({ symbols }, 'Checking symbols...');

  // determine next symbol
  const symbol = await determineNextSymbol(symbols, logger);

  const symbolLogger = logger.child({ symbol, symbolUuid: uuidv4() });

  symbolLogger.info('Start processing symbol...');

  try {
    // 1. Get indicators
    const indicators = await helper.getIndicators(symbol, symbolLogger);

    // 2. Determine actions
    const tradeActionResult = await helper.determineAction(symbolLogger, indicators);
    symbolLogger.info({ tradeActionResult }, 'Determined action.');

    // 3. Place order based on lowest value signal
    let orderResult = {};
    if (tradeActionResult.action === 'buy') {
      orderResult = await helper.placeOrder(symbolLogger, 'buy', 100, indicators);
    } else if (tradeActionResult.action === 'sell') {
      symbolLogger.info(`Got sell signal, but do nothing. Never lose money.`);
    } else {
      orderResult = await helper.chaseStopLossLimitOrder(symbolLogger, indicators);
    }

    symbolLogger.info({ orderResult }, 'Finish processing symbol...');
  } catch (e) {
    symbolLogger.error(e, `${symbol} Execution failed.`);
    if (e.code === -1001) {
      // Let's silent for internal server error
    } else {
      slack.sendMessage(
        `${symbol} Execution failed\nCode: ${e.code}\nMessage:\`\`\`${e.message}\`\`\`Stack:\`\`\`${e.stack}\`\`\``
      );
    }
  }
};

module.exports = { execute };
