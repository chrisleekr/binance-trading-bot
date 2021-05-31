/* eslint-disable no-await-in-loop */
const moment = require('moment');
const { isEmpty } = require('lodash');
const _ = require('lodash');
const { cache, PubSub, binance } = require('../../../helpers');
const {
  getLastBuyPrice,
  saveLastBuyPrice
} = require('../../trailingTradeHelper/common');

/**
 * Retrieve last buy price and recalculate new last buy price
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 */
const calculateLastBuyPrice = async (logger, symbol, order) => {
  const { orderId, fills } = order;
  const lastBuyPriceDoc = await getLastBuyPrice(logger, symbol);

  const lastBuyPrice = _.get(lastBuyPriceDoc, 'lastBuyPrice', 0);

  let totalQuantity = _.get(lastBuyPriceDoc, 'quantity', 0);
  let totalAmount = lastBuyPrice * totalQuantity;

  if (!isEmpty(fills)) {
    fills.forEach(fill => {
      const filledPrice = parseFloat(fill.price);
      const filledQuantity = parseFloat(fill.qty);

      totalQuantity += filledQuantity;
      totalAmount += filledPrice * filledQuantity;
    });
  }

  await saveLastBuyPrice(logger, symbol, {
    lastBuyPrice: totalAmount / totalQuantity,
    quantity: totalQuantity
  });

  await cache.hdel(`trailing-trade-manual-buy-order-${symbol}`, orderId);

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `The last buy price for ${symbol} has been updated.`
  });
};

/**
 * Ensure manual buy order is placed
 *
 * {
      "symbol": "ETHBTC",
      "orderId": 9749,
      "orderListId": -1,
      "clientOrderId": "aBNNh7GfjNnZIzm35GLwAq",
      "transactTime": 1622368454223,
      "price": "0.06828200",
      "origQty": "0.10000000",
      "executedQty": "0.10000000",
      "cummulativeQuoteQty": "0.00682820",
      "status": "FILLED",
      "timeInForce": "GTC",
      "type": "LIMIT",
      "side": "BUY",
      "fills": [
        {
          "price": "0.06828200",
          "qty": "0.10000000",
          "commission": "0.00000000",
          "commissionAsset": "ETH",
          "tradeId": 3153
        }
      ]
    }
    {
      "symbol": "BTCUSDT",
      "orderId": 5674916,
      "orderListId": -1,
      "clientOrderId": "aiYKXjAZmELqEE16mqpFTn",
      "transactTime": 1622368621204,
      "price": "35901.96000000",
      "origQty": "0.00100000",
      "executedQty": "0.00100000",
      "cummulativeQuoteQty": "35.90121000",
      "status": "FILLED",
      "timeInForce": "GTC",
      "type": "LIMIT",
      "side": "BUY",
      "fills": [
        {
          "price": "35901.21000000",
          "qty": "0.00100000",
          "commission": "0.00000000",
          "commissionAsset": "BTC",
          "tradeId": 1471678
        }
      ]
    }


    {
      "symbol": "ETHBTC",
      "orderId": 9752,
      "orderListId": -1,
      "clientOrderId": "HgtQVdcHsqYIXQ47AXt7jL",
      "transactTime": 1622368502241,
      "price": "0.00000000",
      "origQty": "0.01464000",
      "executedQty": "0.01464000",
      "cummulativeQuoteQty": "0.00099964",
      "status": "FILLED",
      "timeInForce": "GTC",
      "type": "MARKET",
      "side": "BUY",
      "fills": [
        {
          "price": "0.06828200",
          "qty": "0.01464000",
          "commission": "0.00000000",
          "commissionAsset": "ETH",
          "tradeId": 3155
        }
      ]
    }

    {
      "symbol": "BTCUSDT",
      "orderId": 5675005,
      "orderListId": -1,
      "clientOrderId": "N5mxvfjIfkMBUmAf71KEOq",
      "transactTime": 1622368662561,
      "price": "0.00000000",
      "origQty": "0.00306300",
      "executedQty": "0.00306300",
      "cummulativeQuoteQty": "109.99701639",
      "status": "FILLED",
      "timeInForce": "GTC",
      "type": "MARKET",
      "side": "BUY",
      "fills": [
        {
          "price": "35911.53000000",
          "qty": "0.00306300",
          "commission": "0.00000000",
          "commissionAsset": "BTC",
          "tradeId": 1471705
        }
      ]
    }

    {
      "symbol": "ETHBTC",
      "orderId": 9753,
      "orderListId": -1,
      "clientOrderId": "jnw8mWBHTxEWFfkqQE0DNL",
      "transactTime": 1622368530571,
      "price": "0.00000000",
      "origQty": "0.01000000",
      "executedQty": "0.01000000",
      "cummulativeQuoteQty": "0.00068282",
      "status": "FILLED",
      "timeInForce": "GTC",
      "type": "MARKET",
      "side": "BUY",
      "fills": [
        {
          "price": "0.06828200",
          "qty": "0.01000000",
          "commission": "0.00000000",
          "commissionAsset": "ETH",
          "tradeId": 3156
        }
      ]
    }

    {
      "symbol": "BTCUSDT",
      "orderId": 5675060,
      "orderListId": -1,
      "clientOrderId": "I8VZV5NR5yZu6xXBxRltMY",
      "transactTime": 1622368688218,
      "price": "0.00000000",
      "origQty": "0.05000000",
      "executedQty": "0.05000000",
      "cummulativeQuoteQty": "1795.75050000",
      "status": "FILLED",
      "timeInForce": "GTC",
      "type": "MARKET",
      "side": "BUY",
      "fills": [
        {
          "price": "35915.01000000",
          "qty": "0.01392200",
          "commission": "0.00000000",
          "commissionAsset": "BTC",
          "tradeId": 1471719
        },
        {
          "price": "35915.01000000",
          "qty": "0.03607800",
          "commission": "0.00000000",
          "commissionAsset": "BTC",
          "tradeId": 1471720
        }
      ]
    }
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolConfiguration: {
      system: { checkManualBuyOrderPeriod }
    }
  } = data;

  const manualBuyOrders = await cache.hgetall(
    `trailing-trade-manual-buy-order-${symbol}`
  );

  if (_.isEmpty(manualBuyOrders) === true) {
    logger.info(
      { manualBuyOrders },
      'Could not find manual buy order, do not process ensure-manual-buy-order.'
    );
    return data;
  }

  // Check if manual-buy-order is existing
  // eslint-disable-next-line no-restricted-syntax
  for (const rawBuyOrder of Object.values(manualBuyOrders)) {
    const buyOrder = JSON.parse(rawBuyOrder);
    logger.info({ buyOrder }, 'Start checking buy order');
    // If filled already, then calculate average price and save
    if (buyOrder.status === 'FILLED') {
      logger.info(
        { buyOrder },
        'Order has already filled, calculate last buy price.'
      );
      await calculateLastBuyPrice(logger, symbol, buyOrder);
    } else {
      // If not filled, check orders is time to check or not

      const nextCheck = _.get(buyOrder, 'nextCheck', null);

      if (moment(nextCheck) < moment()) {
        // Check orders whether it's filled or not
        const orderResult = await binance.client.getOrder({
          symbol,
          orderId: buyOrder.orderId
        });

        // If filled, then calculate average cost and quantity and save new last buy pirce.
        if (orderResult.status === 'FILLED') {
          logger.info(
            { buyOrder },
            'The order is filled, caluclate last buy price.'
          );
          await calculateLastBuyPrice(logger, symbol, orderResult);
        } else {
          // If not filled, update next check time
          const updatedNextCheck = moment().add(
            checkManualBuyOrderPeriod,
            'seconds'
          );

          logger.info(
            {
              orderResult,
              checkManualBuyOrderPeriod,
              nextCheck: updatedNextCheck
            },
            'The order is not filled, update next check time.'
          );

          await cache.hset(
            `trailing-trade-manual-buy-order-${symbol}`,
            orderResult.orderId,
            JSON.stringify({
              ...orderResult,
              nextCheck: updatedNextCheck
            })
          );
        }
      } else {
        logger.info(
          { buyOrder, nextCheck, currentTime: moment() },
          'Skip checking the order'
        );
      }
    }
  }

  return data;
};

module.exports = { execute };
