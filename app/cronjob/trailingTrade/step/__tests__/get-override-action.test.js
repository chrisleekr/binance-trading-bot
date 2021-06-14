/* eslint-disable global-require */
describe('get-override-action.js', () => {
  let result;
  let rawData;

  let loggerMock;

  let mockGetOverrideDataForSymbol;
  let mockRemoveOverrideDataForSymbol;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockGetOverrideDataForSymbol = jest.fn();
      mockRemoveOverrideDataForSymbol = jest.fn();
    });

    describe('when symbol is locked', () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
          removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol
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
          getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
          removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol
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

          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
            action: 'manual-trade',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
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

          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
            action: 'cancel-order',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('triggers removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).toHaveBeenCalledWith(
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

          mockGetOverrideDataForSymbol = jest.fn().mockResolvedValue({
            action: 'something-unknown',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForSymbol: mockGetOverrideDataForSymbol,
            removeOverrideDataForSymbol: mockRemoveOverrideDataForSymbol
          }));

          rawData = {
            action: 'not-determined',
            symbol: 'BTCUSDT',
            isLocked: false
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForSymbol', () => {
          expect(mockGetOverrideDataForSymbol).toHaveBeenCalledWith(
            loggerMock,
            'BTCUSDT'
          );
        });

        it('does not trigger removeOverrideDataForSymbol', () => {
          expect(mockRemoveOverrideDataForSymbol).not.toHaveBeenCalled();
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
