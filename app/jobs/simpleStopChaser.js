const moment = require('moment');
const { v4: uuidv4 } = require('uuid');

const helper = require('./simpleStopChaser/helper');
const { slack, cache } = require('../helpers');

const determineNextSymbol = async (symbols, logger) => {
  const cachedLastSymbol = await cache.hget(
    'simple-stop-chaser-common',
    'last-symbol'
  );

  logger.info({ cachedLastSymbol }, 'Cached last symbol');
  let currentSymbol = symbols[0];
  if (cachedLastSymbol) {
    const cachedSymbolIndex = symbols.indexOf(cachedLastSymbol);
    logger.info({ cachedSymbolIndex }, 'Found symbol index');
    currentSymbol = symbols[cachedSymbolIndex + 1] || symbols[0];
  }

  logger.info({ currentSymbol }, 'Determined current symbol');
  await cache.hset('simple-stop-chaser-common', 'last-symbol', currentSymbol);
  return currentSymbol;
};

const execute = async logger => {
  logger.info('Trade: Start simple-stop-chaser process...');

  const globalConfiguration = await helper.getConfiguration(logger);

  const { symbols } = globalConfiguration;

  logger.info({ symbols }, 'Checking symbols...');

  // determine next symbol
  const symbol = await determineNextSymbol(symbols, logger);

  const symbolLogger = logger.child({ symbol, symbolUuid: uuidv4() });

  symbolLogger.info('Start processing symbol...');
  cache.hset(
    'simple-stop-chaser-common',
    'last-processed',
    JSON.stringify({ timeUTC: moment().utc(), symbol })
  );

  try {
    // 1. Get exchange symbols
    await helper.getExchangeSymbols(symbolLogger, globalConfiguration);

    const symbolConfiguration = await helper.getConfiguration(logger, symbol);

    // 2. Get account info
    const accountInfo = await helper.getAccountInfo(symbolLogger);
    cache.hset(
      'simple-stop-chaser-common',
      `account-info`,
      JSON.stringify(accountInfo)
    );

    // 3. Get indicators
    const indicators = await helper.getIndicators(
      symbolLogger,
      symbol,
      symbolConfiguration
    );

    // 4. Determine actions
    const tradeActionResult = await helper.determineAction(
      symbolLogger,
      indicators,
      symbolConfiguration
    );
    symbolLogger.info({ tradeActionResult }, 'Determined action.');

    // 5. Place order based on lowest value signal
    let buyOrderResult = {};
    if (tradeActionResult.action === 'buy') {
      buyOrderResult = await helper.placeBuyOrder(
        symbolLogger,
        indicators,
        symbolConfiguration
      );
    }

    // 6. If action is wait, then clean up cache
    if (tradeActionResult.action === 'wait') {
      cache.hdel(
        'simple-stop-chaser-symbols',
        `${symbol}-place-buy-order-result`
      );
    }

    // 7. Check stop loss limit order
    const soptLossLimitOrderResult = await helper.chaseStopLossLimitOrder(
      symbolLogger,
      indicators,
      symbolConfiguration
    );

    symbolLogger.info(
      { buyOrderResult, soptLossLimitOrderResult },
      'Trade: Finish simple-stop-chaser process...'
    );
  } catch (e) {
    symbolLogger.error(e, `${symbol} Execution failed.`);
    if (
      e.code === -1001 ||
      e.code === -1021 || // Timestamp for this request is outside of the recvWindow
      e.code === 'ECONNRESET' ||
      e.code === 'ECONNREFUSED'
    ) {
      // Let's silent for internal server error or assumed temporary errors
    } else {
      slack.sendMessage(
        `${symbol} Execution failed\nCode: ${e.code}\nMessage:\`\`\`${e.message}\`\`\`Stack:\`\`\`${e.stack}\`\`\``
      );
    }
  }
};

module.exports = { execute };
