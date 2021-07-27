const tf = require('@tensorflow/tfjs-node');
const _ = require('lodash');
const binance = require('./binance');

const candlesp = [];
const diffWeight = [];
const candlesp2 = [];
const diffWeight2 = [];
const start = async () => {
  const bc = await binance.client.candles({
    symbol: 'BTCUSDT',
    interval: '5m',
    limit: 20
  });
  bc.forEach(c => {
    diffWeight.push(
      100 *
        Math.abs(
          parseFloat(c.open - c.close) / (parseFloat(c.open + c.close) / 2)
        )
    );
    diffWeight2.push(
      100 *
        Math.abs(parseFloat(c.high - c.low) / (parseFloat(c.high + c.low) / 2))
    );
    candlesp.push(parseFloat(c.close));
    candlesp2.push(parseFloat(c.open));
  });

  // create model object
  const model = tf.sequential({
    layers: [tf.layers.dense({ units: 1, inputShape: [20, 20] })]
  });
  // compile model object
  model.compile({
    optimizer: tf.train.sgd(0.1),
    loss: tf.losses.meanSquaredError
  });
  // training datasets
  // In our training datasets, we take room numbers and corresponding price to rent
  const xs = tf.tensor2d([diffWeight],[diffWeight2]);
  const ys = tf.tensor2d([candlesp],[candlesp2]);
  // Train model with fit().method
  await model.fit(xs, ys, { epochs: 1000, batchSize: 8 });
  // Run inference with predict() method.

  const prediction = _.mean(
    await model.predict(tf.tensor1d([2])).dataSync()
  );
  console.log(candlesp);
  console.log(diffWeight);
  console.log(prediction);
};
start();
