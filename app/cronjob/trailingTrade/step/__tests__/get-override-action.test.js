/* eslint-disable global-require */
describe('get-override-action.js', () => {
  let result;
  let rawData;

  let loggerMock;

  let mockGetOverrideData;
  let mockRemoveOverrideData;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockGetOverrideData = jest.fn();
      mockRemoveOverrideData = jest.fn();
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getOverrideData: mockGetOverrideData,
          removeOverrideData: mockRemoveOverrideData
        }));

        rawData = {
          action: 'not-determined',
          symbol: 'BTCUSDT',
          isLocked: true
        };

        const step = require('../get-override-action');
        result = await step.execute(loggerMock, rawData);
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          action: 'not-determined',
          symbol: 'BTCUSDT',
          isLocked: true
        });
      });
    });

    describe('when action is not "not-determined"', () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getOverrideData: mockGetOverrideData,
          removeOverrideData: mockRemoveOverrideData
        }));

        rawData = {
          action: 'buy-order-wait',
          symbol: 'BTCUSDT',
          isLocked: false
        };

        const step = require('../get-override-action');
        result = await step.execute(loggerMock, rawData);
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          action: 'buy-order-wait',
          symbol: 'BTCUSDT',
          isLocked: false
        });
      });
    });

    describe('when action is "not-determined"', () => {
      describe('when action is manual-trade', () => {
        beforeEach(async () => {
          const { logger } = require('../../../../helpers');

          loggerMock = logger;

          mockGetOverrideData = jest.fn().mockResolvedValue({
            action: 'manual-trade',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideData: mockGetOverrideData,
            removeOverrideData: mockRemoveOverrideData
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideData', () => {
          expect(mockGetOverrideData).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers removeOverrideData', () => {
          expect(mockRemoveOverrideData).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'manual-trade',
            symbol: 'BTCUSDT',
            isLocked: false,
            order: {
              some: 'data'
            }
          });
        });
      });

      describe('when action is cancel-order', () => {
        beforeEach(async () => {
          const { logger } = require('../../../../helpers');

          loggerMock = logger;

          mockGetOverrideData = jest.fn().mockResolvedValue({
            action: 'cancel-order',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideData: mockGetOverrideData,
            removeOverrideData: mockRemoveOverrideData
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideData', () => {
          expect(mockGetOverrideData).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers removeOverrideData', () => {
          expect(mockRemoveOverrideData).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'cancel-order',
            symbol: 'BTCUSDT',
            isLocked: false,
            order: {
              some: 'data'
            }
          });
        });
      });

      describe('when action is not matching', () => {
        beforeEach(async () => {
          const { logger } = require('../../../../helpers');

          loggerMock = logger;

          mockGetOverrideData = jest.fn().mockResolvedValue({
            action: 'something-unknown',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideData: mockGetOverrideData,
            removeOverrideData: mockRemoveOverrideData
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideData', () => {
          expect(mockGetOverrideData).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('does not trigger removeOverrideData', () => {
          expect(mockRemoveOverrideData).not.toHaveBeenCalled();
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          });
        });
      });
    });
  });
});
