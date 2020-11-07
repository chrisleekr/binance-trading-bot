/* eslint-disable global-require */
const config = require('config');
const { binance, logger, cache, slack } = require('../../../helpers');
const commonHelper = require('../../common/helper');

const macdStopChaserHelper = require('../helper');

jest.mock('config');

describe('helper', () => {
  let result;

  beforeEach(() => {
    slack.sendMessage = jest.fn().mockResolvedValue(true);
  });

  describe('getIndicators', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.macdStopChaser':
            return {
              symbol: 'BTCUSDT',
              macd: {
                shortPeriod: 12,
                longPeriod: 26,
                signalPeriod: 9
              },
              min: {
                range: {
                  min: 0.99,
                  max: 1.01
                }
              },
              candles: {
                interval: '5m',
                limit: 500
              }
            };
          default:
            return '';
        }
      });

      binance.client.candles = jest.fn().mockResolvedValue(require('./fixtures/binance-candles.json'));

      result = await macdStopChaserHelper.getIndicators(logger);
    });

    it('returns expected result', () => {
      expect(result).toMatchObject(require('./fixtures/helper-get-indicators.json'));
    });
  });

  describe('determineAction', () => {
    const indicators = require('./fixtures/helper-get-indicators.json');

    beforeEach(() => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.macdStopChaser.symbol':
            return 'BTCUSDT';
          default:
            return '';
        }
      });

      cache.set = jest.fn().mockResolvedValue(true);
    });

    describe('when cannot find cache for last-macd-trend-symbol', () => {
      beforeEach(async () => {
        cache.get = jest.fn().mockResolvedValue(null);

        indicators.macdHistory[0] = [25.46957716120596, 25.437284416355396];

        indicators.macdHistory[1] = [16.46624818942374, 18.260455434810073];

        result = await macdStopChaserHelper.determineAction(logger, indicators);
      });

      it('triggers cache.set', () => {
        expect(cache.set).toHaveBeenCalledWith('last-macd-trend-BTCUSDT', 'rising');
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          action: 'hold',
          currentTrend: 'rising',
          lastCandleClose: '15665.71000000',
          lastTrend: 'unknown',
          minHistoryRangeMax: 13880.783500000001
        });
      });
    });

    describe('when found cache for last-macd-trend-symbol', () => {
      describe('when last trend was falling but current trend is rising', () => {
        beforeEach(() => {
          cache.get = jest.fn().mockResolvedValue('falling');

          // Manipulate to make rising trend
          indicators.macdHistory[0] = [25.46957716120596, 25.437284416355396];

          indicators.macdHistory[1] = [16.46624818942374, 18.260455434810073];
        });

        describe('when last closed value is higher than maximum range', () => {
          beforeEach(async () => {
            indicators.lastCandle.close = '15665.71000000';
            indicators.minHistory.range.max = 13880.78350000001;

            result = await macdStopChaserHelper.determineAction(logger, indicators);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({ currentTrend: 'wait', action: 'hold' });
          });
        });

        describe('when last closed value is less than maximum range', () => {
          beforeEach(async () => {
            indicators.lastCandle.close = '13879.71000000';
            indicators.minHistory.range.max = 13880.78350000001;

            result = await macdStopChaserHelper.determineAction(logger, indicators);
          });

          it('triggers cache.set', () => {
            expect(cache.set).toHaveBeenCalledWith('last-macd-trend-BTCUSDT', 'rising');
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              action: 'buy',
              currentTrend: 'rising',
              lastCandleClose: '13879.71000000',
              lastTrend: 'falling',
              minHistoryRangeMax: 13880.78350000001
            });
          });
        });
      });

      describe('when last trend was rising and current trend is rising', () => {
        beforeEach(async () => {
          indicators.lastCandle.close = '15665.71000000';
          indicators.minHistory.range.max = 13880.78350000001;

          cache.get = jest.fn().mockResolvedValue('rising');

          // Manipulate to make rising trend
          indicators.macdHistory[0] = [25.46957716120596, 25.437284416355396];

          indicators.macdHistory[1] = [16.46624818942374, 18.260455434810073];

          result = await macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            action: 'hold',
            currentTrend: 'rising',
            lastCandleClose: '15665.71000000',
            lastTrend: 'rising',
            minHistoryRangeMax: 13880.78350000001
          });
        });
      });

      describe('when last trend was rising and one of trend is falling', () => {
        beforeEach(async () => {
          cache.get = jest.fn().mockResolvedValue('rising');

          indicators.lastCandle.close = '15665.71000000';
          indicators.minHistory.range.max = 13880.78350000001;

          // Manipulate to make rising falling
          indicators.macdHistory[0] = [15.46957716120596, 19.437284416355396];

          indicators.macdHistory[1] = [16.46624818942374, 18.260455434810073];

          result = await macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            action: 'hold',
            currentTrend: 'wait',
            lastCandleClose: '15665.71000000',
            lastTrend: 'rising',
            minHistoryRangeMax: 13880.78350000001
          });
        });
      });

      describe('when last trend was rising and current trend is falling', () => {
        beforeEach(async () => {
          cache.get = jest.fn().mockResolvedValue('rising');

          indicators.lastCandle.close = '15665.71000000';
          indicators.minHistory.range.max = 13880.78350000001;

          // Manipulate to make rising falling
          indicators.macdHistory[0] = [15.46957716120596, 17.437284416355396];

          indicators.macdHistory[1] = [16.46624818942374, 18.260455434810073];

          result = await macdStopChaserHelper.determineAction(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            action: 'sell',
            currentTrend: 'falling',
            lastCandleClose: '15665.71000000',
            lastTrend: 'rising',
            minHistoryRangeMax: 13880.78350000001
          });
        });
      });
    });
  });

  describe('placeOrder', () => {
    const indicators = require('./fixtures/helper-get-indicators.json');

    beforeEach(() => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.macdStopChaser.symbol':
            return 'BTCUSDT';
          default:
            return '';
        }
      });

      cache.set = jest.fn().mockResolvedValue(true);

      binance.client.order = jest.fn().mockResolvedValue(true);

      commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue(true);
      commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(require('./fixtures/helper-get-symbol-info.json'));
    });

    describe('when fail to get balance', () => {
      beforeEach(async () => {
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: false
        });
        result = await macdStopChaserHelper.placeOrder(logger, 'buy', 100, indicators);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false
        });
      });
    });

    describe('when fail to get quantity to order', () => {
      beforeEach(async () => {
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 0.00005
        });

        result = await macdStopChaserHelper.placeOrder(logger, 'buy', 100, indicators);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          baseAssetPrice: 15665.71,
          freeBalance: 0.00005,
          message: 'Order quantity is less or equal than 0.',
          orderQuantity: 0
        });
      });
    });

    describe('when fail to get order price to roder', () => {
      beforeEach(async () => {
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 0.01
        });

        result = await macdStopChaserHelper.placeOrder(logger, 'buy', 100, indicators);
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          result: false,
          message: 'Notional value is less than minimum notional value.',
          orderPrice: 15665.71
        });
      });
    });

    describe('when good to buy order', () => {
      beforeEach(async () => {
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 50
        });

        result = await macdStopChaserHelper.placeOrder(logger, 'buy', 100, indicators);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          price: 15665.71,
          quantity: 0.003188,
          side: 'buy',
          symbol: 'BTCUSDT',
          timeInForce: 'GTC',
          type: 'LIMIT'
        });
      });

      it('triggers cache.set', () => {
        expect(cache.set).toHaveBeenCalledWith('last-buy-price-BTCUSDT', 15665.71);
      });

      it('returns expected result', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('when good to sell order', () => {
      beforeEach(async () => {
        commonHelper.getBalance = jest.fn().mockResolvedValue({
          result: true,
          message: 'Balance found',
          freeBalance: 0.005
        });

        result = await macdStopChaserHelper.placeOrder(logger, 'sell', 100, indicators);
      });

      it('triggers binance.client.order', () => {
        expect(binance.client.order).toHaveBeenCalledWith({
          price: 15665.71,
          quantity: 0.004995,
          side: 'sell',
          symbol: 'BTCUSDT',
          timeInForce: 'GTC',
          type: 'LIMIT'
        });
      });

      it('triggers cache.set', () => {
        expect(cache.set).toHaveBeenCalledWith('last-buy-price-BTCUSDT', 15665.71);
      });

      it('returns expected result', () => {
        expect(result).toBeTruthy();
      });
    });
  });

  describe('chaseStopLossLimitOrder', () => {
    let indicators;
    let symbolInfo;
    let stopLossLimit;

    beforeEach(() => {
      indicators = require('./fixtures/helper-get-indicators.json');
      symbolInfo = require('./fixtures/helper-get-symbol-info.json');
      stopLossLimit = {
        lastBuyPercentage: 1.03,
        stopPercentage: 0.99,
        limitPercentage: 0.98
      };

      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.macdStopChaser.symbol':
            return 'BTCUSDT';
          case 'jobs.macdStopChaser.stopLossLimit':
            return stopLossLimit;
          default:
            return '';
        }
      });
    });

    describe('when there is no open order', () => {
      beforeEach(() => {
        commonHelper.getOpenOrders = jest.fn().mockResolvedValue([]);

        cache.set = jest.fn().mockResolvedValue(true);
        binance.client.order = jest.fn().mockResolvedValue(true);

        commonHelper.getSymbolInfo = jest.fn().mockResolvedValue(symbolInfo);
      });

      describe('when there is no balance', () => {
        beforeEach(async () => {
          commonHelper.getBalance = jest.fn().mockResolvedValue({
            result: false
          });

          result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({ result: false });
        });
      });

      describe('when last buy price is not cached', () => {
        const balanceInfo = {
          result: true,
          message: 'Balance found',
          freeBalance: 0.05
        };

        beforeEach(async () => {
          commonHelper.getBalance = jest.fn().mockResolvedValue(balanceInfo);

          cache.get = jest.fn().mockResolvedValue(null);

          commonHelper.placeStopLossLimitOrder = jest.fn().mockResolvedValue(true);

          result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
        });

        it('triggers commonHelper.placeStopLossLimitOrder', () => {
          expect(commonHelper.placeStopLossLimitOrder).toHaveBeenCalledWith(
            logger,
            binance,
            slack,
            symbolInfo,
            balanceInfo,
            indicators,
            stopLossLimit
          );
        });

        it('returns expected result', () => {
          expect(result).toBeTruthy();
        });
      });

      describe('when last buy price is cached', () => {
        const balanceInfo = {
          result: true,
          message: 'Balance found',
          freeBalance: 0.05
        };

        beforeEach(async () => {
          commonHelper.getBalance = jest.fn().mockResolvedValue(balanceInfo);

          commonHelper.placeStopLossLimitOrder = jest.fn().mockResolvedValue(true);
        });

        describe('when closed price is lower than last buy price', () => {
          beforeEach(async () => {
            cache.get = jest.fn().mockResolvedValue(15665);

            result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
          });

          it('returns expected result', () => {
            expect(result).toStrictEqual({
              result: false,
              message: 'Last buy price is lower than current price. Do not place order.',
              lastCandleClose: 15665.71,
              lastBuyPrice: 15665,
              calculatedLastBuyPrice: 16134.95
            });
          });
        });

        describe('when closed price is more than last buy price', () => {
          beforeEach(async () => {
            cache.get = jest.fn().mockResolvedValue(15200);

            result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
          });

          it('triggers commonHelper.placeStopLossLimitOrder', () => {
            expect(commonHelper.placeStopLossLimitOrder).toHaveBeenCalledWith(
              logger,
              binance,
              slack,
              symbolInfo,
              balanceInfo,
              indicators,
              stopLossLimit
            );
          });

          it('returns expected result', () => {
            expect(result).toBeTruthy();
          });
        });
      });
    });

    describe('when there is a open order', () => {
      beforeEach(() => {
        commonHelper.cancelOpenOrders = jest.fn().mockResolvedValue(true);
      });

      describe('when last order is not STOP_LOSS_LIMIT', () => {
        beforeEach(async () => {
          commonHelper.getOpenOrders = jest.fn().mockResolvedValue([
            {
              type: 'LIMIT',
              stopPrice: '0.0000'
            }
          ]);

          result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: false,
            message: 'Order is not STOP_LOSS_LIMIT, Do nothing.'
          });
        });
      });

      describe('when order stop price is less than limit percentage', () => {
        beforeEach(async () => {
          indicators.lastCandle.close = '12600.00';
          commonHelper.getOpenOrders = jest.fn().mockResolvedValue([
            {
              type: 'STOP_LOSS_LIMIT',
              stopPrice: 11529.44
            }
          ]);

          result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
        });

        it('triggers commonHelper.cancelOpenOrders', () => {
          expect(commonHelper.cancelOpenOrders).toHaveBeenCalledWith(logger, binance, 'BTCUSDT');
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: true,
            message: 'Finished to handle chaseStopLossLimitOrder'
          });
        });
      });

      describe('when order stop price is more than limit percentage', () => {
        beforeEach(async () => {
          indicators.lastCandle.close = '11300.00';
          commonHelper.getOpenOrders = jest.fn().mockResolvedValue([
            {
              type: 'STOP_LOSS_LIMIT',
              stopPrice: 11529.44
            }
          ]);

          result = await macdStopChaserHelper.chaseStopLossLimitOrder(logger, indicators);
        });

        it('does not trigger commonHelper.cancelOpenOrders', () => {
          expect(commonHelper.cancelOpenOrders).not.toHaveBeenCalled();
        });

        it('returns expected result', () => {
          expect(result).toStrictEqual({
            result: true,
            message: 'Finished to handle chaseStopLossLimitOrder'
          });
        });
      });
    });
  });
});
