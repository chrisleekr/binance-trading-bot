const _ = require('lodash');
const moment = require('moment');

const filterValidTradingViews = (
  _logger,
  side,
  tradingViewsConfigs,
  tradingViews,
  { useOnlyWithin, ifExpires }
) => {
  // Now check TradingView data time.
  const currentTime = moment.utc();

  let hasExpiredTradingView = false;
  const validTradingViews = _.filter(tradingViews, tradingView => {
    // If TradingView time or recommendation is not able to fetch, then ignore TradingView data.
    const tradingViewTime = _.get(tradingView, 'result.time', '');
    if (
      tradingViewTime === '' ||
      _.get(tradingView, 'result.summary.RECOMMENDATION', '') === ''
    ) {
      return false;
    }

    const tradingViewUpdatedAt = moment
      .utc(tradingViewTime, 'YYYY-MM-DDTHH:mm:ss.SSSSSS')
      .add(useOnlyWithin, 'minutes');

    // If TradingView updated time is expired
    if (tradingViewUpdatedAt.isBefore(currentTime)) {
      // If set to not buy if TradingView is expired, then set the flag variable.
      if (side === 'buy' && ifExpires === 'do-not-buy') {
        hasExpiredTradingView = true;
        return true;
      }

      // If the update time is expired, then it's not valid TradingView.
      return false;
    }

    // Otherwise, consider as valid data.
    return true;
  });

  // Check if has all TradingView data is cached.
  const hasAllTradingViews = tradingViewsConfigs.every(
    config =>
      tradingViews.find(tv => tv.request.interval === config.interval) !==
      undefined
  );

  return { hasExpiredTradingView, hasAllTradingViews, validTradingViews };
};

const validateTradingViewsForBuy = (logger, data) => {
  const {
    symbolConfiguration: {
      botOptions: {
        tradingViews: tradingViewsConfigs,
        tradingViewOptions: { useOnlyWithin, ifExpires }
      }
    },
    tradingViews
  } = data;

  if (!tradingViewsConfigs) {
    return {
      isTradingViewAllowed: false,
      tradingViewRejectedReason:
        'Do not place an order because there are missing TradingView configuration.'
    };
  }
  // If all TradingViews buy configuration is not enabled, then no need to check.
  if (
    tradingViewsConfigs.every(c => {
      const p = c.buy;
      return p.whenStrongBuy === false && p.whenBuy === false;
    })
  ) {
    logger.info(
      'There is no buy condition configured. Ignore TradingView recommendation.'
    );
    return {
      isTradingViewAllowed: true,
      tradingViewRejectedReason: ''
    };
  }

  const { hasExpiredTradingView, validTradingViews, hasAllTradingViews } =
    filterValidTradingViews(logger, 'buy', tradingViewsConfigs, tradingViews, {
      useOnlyWithin,
      ifExpires
    });

  if (hasExpiredTradingView === true) {
    return {
      isTradingViewAllowed: false,
      tradingViewRejectedReason:
        `Do not place an order because ` +
        `TradingView data is older than ${useOnlyWithin} minutes.`
    };
  }

  if (_.isEmpty(validTradingViews) === true) {
    logger.info(
      'TradingView time or recommendation is empty. Ignore TradingView recommendation.'
    );
    return { isTradingViewAllowed: true, tradingViewRejectedReason: '' };
  }

  if (hasAllTradingViews === false) {
    return {
      isTradingViewAllowed: false,
      tradingViewRejectedReason:
        'Do not place an order because there are missing TradingView data.'
    };
  }

  logger.info('TradingView is valid.');

  return {
    isTradingViewAllowed: undefined,
    tradingViewRejectedReason: '',
    validTradingViews
  };
};

const isBuyAllowedByTradingView = (logger, data) => {
  const {
    symbolConfiguration: {
      botOptions: { tradingViews: tradingViewsConfigs }
    },
    overrideData
  } = data;

  const overrideCheckTradingView = _.get(
    overrideData,
    'checkTradingView',
    false
  );

  // If this is override action, then process buy regardless recommendation.
  if (overrideCheckTradingView === false && _.isEmpty(overrideData) === false) {
    logger.info(
      { overrideData },
      'Override data is not empty. Ignore TradingView recommendation.'
    );
    return { isTradingViewAllowed: true, tradingViewRejectedReason: '' };
  }

  // Validate TradingView data.
  const { isTradingViewAllowed, tradingViewRejectedReason, validTradingViews } =
    validateTradingViewsForBuy(logger, data);

  // If tradingViewAllowed is returned by validation, then return the result.
  if (isTradingViewAllowed !== undefined) {
    return {
      isTradingViewAllowed,
      tradingViewRejectedReason
    };
  }

  // Can buy if all buy conditions are satisfied among all TradingViews.
  let rejectedReason = '';
  const hasSatisfiedAllRecommendations = validTradingViews.every(
    tradingView => {
      // Retreive tradingView configurations. It must have at this point.
      const config = tradingViewsConfigs.find(
        c => c.interval === tradingView.request.interval
      );

      const allowedRecommendations = [];

      if (config.buy.whenStrongBuy) {
        allowedRecommendations.push('strong_buy');
      }
      if (config.buy.whenBuy) {
        allowedRecommendations.push('buy');
      }

      // If recommendation is not selected, ignore this TradingView data and proceed to buy.
      if (allowedRecommendations.length === 0) {
        return true;
      }

      // If tradingView recommendation is one of configured recommendation, then proceed to buy.
      if (
        allowedRecommendations.includes(
          tradingView.result.summary.RECOMMENDATION.toLowerCase()
        ) === true
      ) {
        return true;
      }

      // Otherwise, should prevent buying.
      rejectedReason =
        `Do not place an order because TradingView recommendation for ` +
        `${tradingView.request.interval} is ${tradingView.result.summary.RECOMMENDATION}.`;

      return false;
    }
  );

  // If summary recommendation is not allowed recommendation, then prevent buy
  if (hasSatisfiedAllRecommendations === false) {
    return {
      isTradingViewAllowed: false,
      tradingViewRejectedReason: rejectedReason
    };
  }

  // Otherwise, simply allow
  return {
    isTradingViewAllowed: true,
    tradingViewRejectedReason: ''
  };
};

const validateTradingViewsForForceSell = (logger, data) => {
  const {
    symbolConfiguration: {
      botOptions: {
        tradingViews: tradingViewsConfigs,
        tradingViewOptions: { useOnlyWithin, ifExpires }
      }
    },
    tradingViews
  } = data;

  if (!tradingViewsConfigs) {
    return {
      shouldForceSell: false,
      forceSellMessage:
        'Do not place an order because there are missing TradingView configuration.'
    };
  }

  // If all TradingViews force sell configuration is not enabled, then no need to check.
  if (
    tradingViewsConfigs.every(c => {
      const p = c.sell.forceSellOverZeroBelowTriggerPrice;
      return (
        p.whenNeutral === false &&
        p.whenSell === false &&
        p.whenStrongSell === false
      );
    })
  ) {
    logger.info(
      'There is no sell condition configured. Ignore TradingView recommendation.'
    );
    return {
      shouldForceSell: false,
      forceSellMessage: ''
    };
  }

  const { validTradingViews, hasAllTradingViews } = filterValidTradingViews(
    logger,
    'sell',
    tradingViewsConfigs,
    tradingViews,
    {
      useOnlyWithin,
      ifExpires
    }
  );

  if (_.isEmpty(validTradingViews) === true) {
    logger.info(
      'TradingView time or recommendation is empty. Ignore TradingView recommendation.'
    );
    return { shouldForceSell: false, forceSellMessage: '' };
  }

  if (hasAllTradingViews === false) {
    return {
      shouldForceSell: false,
      forceSellMessage:
        'Do not force-sell because there are missing TradingView data.'
    };
  }

  logger.info('TradingView is valid.');

  return {
    shouldForceSell: undefined,
    forceSellMessage: '',
    validTradingViews
  };
};

const shouldForceSellByTradingView = (logger, data) => {
  const {
    symbolInfo: {
      filterLotSize: { stepSize },
      filterMinNotional: { minNotional }
    },
    symbolConfiguration: {
      botOptions: { tradingViews: tradingViewsConfigs }
    },
    baseAssetBalance: { free: baseAssetFreeBalance },
    sell: {
      currentProfit: sellCurrentProfit,
      currentPrice: sellCurrentPrice,
      triggerPrice: sellTriggerPrice
    }
  } = data;

  // Validate TradingView data.
  const { shouldForceSell, forceSellMessage, validTradingViews } =
    validateTradingViewsForForceSell(logger, data);

  // If shouldForceSell is returned by validation, then return the result.
  if (shouldForceSell !== undefined) {
    return {
      shouldForceSell,
      forceSellMessage
    };
  }

  // If current profit is less than 0 or current price is more than trigger price
  if (sellCurrentProfit <= 0 || sellCurrentPrice > sellTriggerPrice) {
    logger.info(
      { sellCurrentProfit, sellCurrentPrice, sellTriggerPrice },
      `Current profit if equal or less than 0 or ` +
        `current price is more than trigger price. Ignore TradingView recommendation.`
    );

    return { shouldForceSell: false, forceSellMessage: '' };
  }

  // Only execute when the free balance is more than minimum notional value.
  const lotPrecision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const freeBalance = parseFloat(_.floor(baseAssetFreeBalance, lotPrecision));
  const orderQuantity = parseFloat(
    _.floor(freeBalance - freeBalance * (0.1 / 100), lotPrecision)
  );

  if (orderQuantity * sellCurrentPrice < parseFloat(minNotional)) {
    logger.info(
      { sellCurrentProfit, sellCurrentPrice, sellTriggerPrice },
      'Order quantity is less than minimum notional value. Ignore TradingView recommendation.'
    );

    return { shouldForceSell: false, forceSellMessage: '' };
  }

  let forceSellReason = '';
  const hasAnyForceSellRecommendation = validTradingViews.some(tradingView => {
    // Retreive tradingView configurations. It must have at this point.
    const config = tradingViewsConfigs.find(
      c => c.interval === tradingView.request.interval
    );

    const sellConfig = config.sell.forceSellOverZeroBelowTriggerPrice;

    // Get force sell recommendation
    const forceSellRecommendations = [];
    if (sellConfig.whenNeutral) {
      forceSellRecommendations.push('neutral');
    }

    if (sellConfig.whenSell) {
      forceSellRecommendations.push('sell');
    }

    if (sellConfig.whenStrongSell) {
      forceSellRecommendations.push('strong_sell');
    }

    // If recommendation is not selected, ignore this TradingView data and do not sell.
    if (forceSellRecommendations.length === 0) {
      return false;
    }

    // If tradingView recommendation is one of configured recommendation, then proceed to sell.
    const recommendation =
      tradingView.result.summary.RECOMMENDATION.toLowerCase();
    if (forceSellRecommendations.includes(recommendation) === true) {
      forceSellReason =
        `TradingView recommendation for ${tradingView.request.interval} is ${recommendation}. ` +
        `The current profit (${sellCurrentProfit}) is more than 0 and the current price (${sellCurrentPrice}) ` +
        `is under trigger price (${sellTriggerPrice}). Sell at market price.`;
      return true;
    }

    // Otherwise, do not sell
    return false;
  });

  // If there is at least one satified force sell configuration, then return to force sell.
  if (hasAnyForceSellRecommendation) {
    return { shouldForceSell: true, forceSellMessage: forceSellReason };
  }

  // Otherwise ignore.
  return { shouldForceSell: false, forceSellMessage: '' };
};

module.exports = { isBuyAllowedByTradingView, shouldForceSellByTradingView };
