/* istanbul ignore file */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-console */
const { cache, logger } = require('../helpers');

// eslint-disable-next-line no-promise-executor-return
const sleep = async ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  logger.info('Test cache');

  // Set cache with ttl
  await cache.set('TEST', true, 5);

  let result;

  result = await cache.keys('*grid-trade-last*');
  console.log(result);
  for (const key of result) {
    console.log(key);
  }

  result = await cache.keys('trailing-trade-manual-order*');
  console.log(result);
  for (const key of result) {
    console.log(key);
  }

  result = await cache.getWithTTL('TEST');
  console.log({ value: result[1][1] === 'true', ttl: result[0][1] });
  await sleep(1000);
  result = await cache.getWithTTL('TEST');
  console.log({ value: result[1][1] === 'true', ttl: result[0][1] });
  await sleep(1000);
  result = await cache.getWithTTL('TEST');
  console.log({ value: result[1][1] === 'true', ttl: result[0][1] });
  await sleep(1000);
  result = await cache.getWithTTL('TEST');
  console.log({ value: result[1][1] === 'true', ttl: result[0][1] });
  await sleep(1000);
  result = await cache.getWithTTL('TEST');
  console.log({ value: result[1][1] === 'true', ttl: result[0][1] });
  await sleep(1000);
  result = await cache.getWithTTL('TEST');
  console.log({ value: result[1][1] === 'true', ttl: result[0][1] });
  process.exit(0);
})();
