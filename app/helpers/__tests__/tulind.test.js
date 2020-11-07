/* eslint-disable global-require */
const tulind = require('../tulind');

describe('tulind', () => {
  let result;

  const candlesData = require('./fixtures/helper-flatten-candles-data.json');

  describe('bbands', () => {
    beforeEach(async () => {
      result = await tulind.bbands(candlesData, 50, 2);
    });

    it('returns expected value', () => {
      expect(result).toMatchObject(require('./fixtures/helper-bbands-result.json'));
    });
  });

  describe('sma', () => {
    beforeEach(async () => {
      result = await tulind.sma(candlesData, 50);
    });

    it('returns expected value', () => {
      expect(result).toMatchObject(require('./fixtures/helper-sma-result.json'));
    });
  });

  describe('macd', () => {
    beforeEach(async () => {
      result = await tulind.macd(candlesData, 12, 26, 9);
    });

    it('returns expected value', () => {
      expect(result).toMatchObject(require('./fixtures/helper-macd-result.json'));
    });
  });
});
