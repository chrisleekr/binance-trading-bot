const _ = require('lodash');
const tf = require('@tensorflow/tfjs');
const { binance, cache, messenger } = require('../../../helpers');

/**
 * Flatten candle data
 *
 * @param {*} candles
 */
const flattenCandlesData = candles => {
  const openTime = [];
  const high = [];
  const low = [];
  const close = [];

  candles.forEach(candle => {
    openTime.push(+candle.openTime);
    high.push(+candle.high);
    low.push(+candle.low);
    close.push(+candle.close);
  });

  return {
    openTime,
    high,
    low,
    close
  };
};

const huskyTrend = (candles, strategyOptions) => {
  const candleLows = candles.close;

  const {
    huskyOptions: { positive, negative }
  } = strategyOptions;
  let newCandle = 1;
  let diff = 0;
  let status = 'not enough data';
  const positiveMultiplier = positive;
  const negativeMultiplier = -negative;

  candleLows.forEach(candle => {
    const newCandleToTest = candleLows[newCandle];
    if (newCandleToTest !== undefined) {
      let calc = 0;
      if (candle <= newCandleToTest) {
        calc = (newCandleToTest - candle) * positiveMultiplier;
      } else {
        calc = (candle - newCandleToTest) * negativeMultiplier;
      }

      const finalCalc = (calc / candle) * 100;

      diff += finalCalc;
    }
    newCandle += 1;
  });

  const difference = diff.toFixed(2);

  // eslint-disable-next-line default-case
  switch (Math.sign(difference)) {
    case -1:
      status = 'FALLING';
      break;
    case 0:
      status = 'TURNING';
      break;
    case 1:
      status = 'UP';
      break;
  }

  return { status, difference };
};

const predictCoinValue = async symbol => {
  const candlesToPredict = [];
  const diffWeight = [];

  let prediction = {
    interval: '30m',
    predictedValues: [],
    meanPredictedValue: [],
    realCandles: [],
    date: new Date()
  };

  const cachedPrediction =
    JSON.parse(await cache.get(`${symbol}-last-prediction`)) || [];

  if (cachedPrediction !== [] && !_.isEmpty(prediction.predictedValues)) {
    prediction = cachedPrediction;
  }

  if (
    (new Date() - new Date(prediction.date)) / 1000 > 180 ||
    _.isEmpty(prediction.predictedValues)
  ) {
    const bc = await binance.client.candles({
      symbol,
      interval: '3m',
      limit: 10
    });

    if (!_.isEmpty(bc)) {
      bc.forEach(c => {
        diffWeight.push(100 - (parseFloat(c.open) / parseFloat(c.close)) * 100);

        candlesToPredict.push(parseFloat(c.close));
      });

      // create model object
      const model = tf.sequential({
        layers: [tf.layers.dense({ units: 1, inputShape: [1] })]
      });
      // compile model object
      model.compile({
        optimizer: tf.train.sgd(0.1),
        loss: tf.losses.meanSquaredError
      });
      // training datasets
      // In our training datasets, we take room numbers and corresponding price to rent
      const xs = tf.tensor1d(diffWeight);
      const ys = tf.tensor1d(candlesToPredict);
      // Train model with fit().method
      await model.fit(xs, ys, { epochs: 1500, batchSize: 8 });
      // Run inference with predict() method.

      const predictionCoinValue = _.mean(
        await model.predict(tf.tensor1d(diffWeight)).dataSync()
      );

      if (prediction.predictedValues.length === 10) {
        prediction.predictedValues.shift();
      }

      prediction.predictedValues.push(predictionCoinValue);
      prediction.meanPredictedValue = [_.mean(prediction.predictedValues)];
      prediction.realCandles = candlesToPredict;
      prediction.date = new Date();

      if (!_.isEmpty(prediction.predictedValues)) {
        await cache.set(
          `${symbol}-last-prediction`,
          JSON.stringify(prediction)
        );
      }
    }
  } else {
    prediction = cachedPrediction;
  }

  return prediction;
};

/**
 * Get symbol information, buy/sell indicators
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    symbol,
    symbolConfiguration: {
      candles: { interval, limit },
      buy: { predictValue },
      strategyOptions,
      strategyOptions: {
        athRestriction: {
          enabled: buyATHRestrictionEnabled,
          candles: {
            interval: buyATHRestrictionCandlesInterval,
            limit: buyATHRestrictionCandlesLimit
          }
        }
      }
    }
  } = data;

  // Retrieve candles
  logger.info(
    { debug: true, function: 'candles', interval, limit },
    'Retrieving candles from API'
  );
  const candles = await binance.client.candles({
    symbol,
    interval,
    limit
  });

  // Flatten candles data to get lowest price
  const candlesData = flattenCandlesData(candles);

  const huskyIndicator = huskyTrend(candlesData, strategyOptions);

  const trend = {
    status: huskyIndicator.status,
    trendDiff: huskyIndicator.difference,
    signedTrendDiff: Math.sign(huskyIndicator.difference)
  };

  // Get lowest price
  const lowestPrice = _.min(candlesData.low);

  const highestPrice = _.max(candlesData.high);
  logger.info(
    { lowestPrice, highestPrice },
    'Retrieved lowest/highest price and Indicators'
  );

  let athPrice = null;

  if (buyATHRestrictionEnabled) {
    logger.info(
      {
        debug: true,
        function: 'athCandles',
        buyATHRestrictionEnabled,
        buyATHRestrictionCandlesInterval,
        buyATHRestrictionCandlesLimit
      },
      'Retrieving ATH candles from API'
    );
    const athCandles = await binance.client.candles({
      symbol,
      interval: buyATHRestrictionCandlesInterval,
      limit: buyATHRestrictionCandlesLimit
    });

    // Flatten candles data to get ATH price
    const athCandlesData = flattenCandlesData(athCandles);

    // ATH (All The High) price
    athPrice = _.max(athCandlesData.high);
  } else {
    logger.info(
      {
        debug: true,
        function: 'athCandles',
        buyATHRestrictionEnabled,
        buyATHRestrictionCandlesInterval,
        buyATHRestrictionCandlesLimit
      },
      'ATH Restriction is disabled'
    );
  }

  let prediction;
  if (predictValue === true) {
    try {
      prediction = await predictCoinValue(symbol);
    } catch (error) {
      messenger.errorMessage(`error at prediction ${error}`);
    }
  }

  data.indicators = {
    highestPrice,
    lowestPrice,
    athPrice,
    trend,
    prediction
  };

  return data;
};

module.exports = { execute };
