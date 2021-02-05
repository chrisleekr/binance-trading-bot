const moment = require('moment');
const config = require('config');
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

const getConfiguration = async logger => {
  const configValue =
    (await cache.hget('simple-stop-chaser-common', 'configuration')) || '';

  let simpleStopChaserConfig = {};
  try {
    simpleStopChaserConfig = JSON.parse(configValue);
  } catch (e) {
    simpleStopChaserConfig = config.get('jobs.simpleStopChaser');
  }

  logger.info({ simpleStopChaserConfig }, 'Simple stop chaser configuration');
  await cache.hset(
    'simple-stop-chaser-common',
    'configuration',
    JSON.stringify(simpleStopChaserConfig)
  );

  return simpleStopChaserConfig;
};

const execute = async logger => {
  logger.info('Trade: Simple Stop-Chasing');

  const simpleStopChaser = await getConfiguration(logger);

  const { symbols } = simpleStopChaser;

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
    // 0. Get account info
    const accountInfo = await helper.getAccountInfo(symbolLogger);
    cache.hset(
      'simple-stop-chaser-common',
      `account-info`,
      JSON.stringify(accountInfo)
    );

    // 1. Get indicators
    const indicators = await helper.getIndicators(symbol, symbolLogger);

    // 2. Determine actions
    const tradeActionResult = await helper.determineAction(
      symbolLogger,
      indicators
    );
    symbolLogger.info({ tradeActionResult }, 'Determined action.');

    // 3. Place order based on lowest value signal
    let orderResult = {};
    if (tradeActionResult.action === 'buy') {
      orderResult = await helper.placeBuyOrder(symbolLogger, indicators);
    } else if (tradeActionResult.action === 'sell') {
      symbolLogger.warn(`Got sell signal, but do nothing. Never lose money.`);
    } else {
      orderResult = await helper.chaseStopLossLimitOrder(
        symbolLogger,
        indicators
      );
    }

    if (orderResult.result) {
      symbolLogger.info({ orderResult }, 'Finish processing symbol...');
    } else {
      symbolLogger.warn({ orderResult }, 'Finish processing symbol...');
    }
  } catch (e) {
    symbolLogger.error(e, `${symbol} Execution failed.`);
    if (
      e.code === -1001 ||
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
