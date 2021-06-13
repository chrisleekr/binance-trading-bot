/* eslint-disable global-require */
describe('get-override-action.js', () => {
  let result;
  let rawData;

  let loggerMock;

  let mockGetOverrideDataForIndicator;
  let mockRemoveOverrideDataForIndicator;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockGetOverrideDataForIndicator = jest.fn();
      mockRemoveOverrideDataForIndicator = jest.fn();
    });

    describe('when action is not "not-determined"', () => {
      beforeEach(async () => {
        const { logger } = require('../../../../helpers');

        loggerMock = logger;

        jest.mock('../../../trailingTradeHelper/common', () => ({
          getOverrideDataForIndicator: mockGetOverrideDataForIndicator,
          removeOverrideDataForIndicator: mockRemoveOverrideDataForIndicator
        }));

        rawData = {
          action: 'some-action'
        };

        const step = require('../get-override-action');
        result = await step.execute(loggerMock, rawData);
      });

      it('retruns expected result', () => {
        expect(result).toStrictEqual({
          action: 'some-action'
        });
      });
    });

    describe('when action is "not-determined"', () => {
      describe('when action is dust-transfer', () => {
        beforeEach(async () => {
          const { logger } = require('../../../../helpers');

          loggerMock = logger;

          mockGetOverrideDataForIndicator = jest.fn().mockResolvedValue({
            action: 'dust-transfer',
            params: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForIndicator: mockGetOverrideDataForIndicator,
            removeOverrideDataForIndicator: mockRemoveOverrideDataForIndicator
          }));

          rawData = {
            action: 'not-determined'
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForIndicator', () => {
          expect(mockGetOverrideDataForIndicator).toHaveBeenCalledWith(
            loggerMock,
            'global'
          );
        });

        it('triggers removeOverrideDataForIndicator', () => {
          expect(mockRemoveOverrideDataForIndicator).toHaveBeenCalledWith(
            loggerMock,
            'global'
          );
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'dust-transfer',
            overrideParams: {
              some: 'data'
            }
          });
        });
      });

      describe('when action is not matching', () => {
        beforeEach(async () => {
          const { logger } = require('../../../../helpers');

          loggerMock = logger;

          mockGetOverrideDataForIndicator = jest.fn().mockResolvedValue({
            action: 'something-unknown',
            order: {
              some: 'data'
            }
          });
          jest.mock('../../../trailingTradeHelper/common', () => ({
            getOverrideDataForIndicator: mockGetOverrideDataForIndicator,
            removeOverrideDataForIndicator: mockRemoveOverrideDataForIndicator
          }));

          rawData = {
            action: 'not-determined'
          };

          const step = require('../get-override-action');
          result = await step.execute(loggerMock, rawData);
        });

        it('triggers getOverrideDataForIndicator', () => {
          expect(mockGetOverrideDataForIndicator).toHaveBeenCalledWith(
            loggerMock,
            'global'
          );
        });

        it('does not trigger removeOverrideDataForIndicator', () => {
          expect(mockRemoveOverrideDataForIndicator).not.toHaveBeenCalled();
        });

        it('retruns expected result', () => {
          expect(result).toStrictEqual({
            action: 'not-determined'
          });
        });
      });
    });
  });
});
