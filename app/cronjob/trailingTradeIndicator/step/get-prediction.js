const tf = require('@tensorflow/tfjs-node');
const { binance } = require('../../../helpers');

/**
 * Get symbol information, buy/sell indicators
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { symbol } = data;

  const candles = [];
  const diffWeight = [0];
  const bc = await binance.client.candles({
    symbol,
    interval: '1m',
    limit: 3
  });
  let i = 1;
  bc.forEach(c => {
    if (bc.length > i) {
      if (c.close > bc[i].close) {
        diffWeight.push(parseFloat(c.close - bc[i].close) / 1000);
      } else {
        diffWeight.push(parseFloat(bc[i].close - c.close) / 1000);
      }
    }
    candles.push(parseFloat(c.close));
    i += 1;
  });

  // create model object
  const model = tf.sequential();
  model.add(
    tf.layers.dense({
      units: 1,
      inputShape: [1]
    })
  );
  // compile model object
  model.compile({
    optimizer: 'sgd',
    loss: 'meanSquaredError'
  });
  // training datasets
  // In our training datasets, we take room numbers and corresponding price to rent
  const xs = tf.tensor1d(diffWeight);
  const ys = tf.tensor1d(candles);
  // Train model with fit().method
  await model.fit(xs, ys, { epochs: 1500 });
  // Run inference with predict() method.
  console.log(candles);
  console.log(diffWeight);

  // eslint-disable-next-line prefer-destructuring
  data.prediction = model.predict(tf.tensor1d(diffWeight))[0];

  return data;
};

module.exports = { execute };
