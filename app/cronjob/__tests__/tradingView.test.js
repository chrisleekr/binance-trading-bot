/* eslint-disable max-classes-per-file */
/* eslint-disable global-require */
const { logger } = require('../../helpers');

describe('tradingView', () => {
  let mockLoggerInfo;

  let mockGetGlobalConfiguration;
  let mockGetTradingView;

  let mockErrorHandlerWrapper;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockLoggerInfo = jest.fn();

    logger.info = mockLoggerInfo;
    jest.mock('../../helpers', () => ({
      logger: {
        info: mockLoggerInfo,
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        child: jest.fn()
      }
    }));

    mockErrorHandlerWrapper = jest
      .fn()
      .mockImplementation((_logger, _job, callback) =>
        Promise.resolve(callback())
      );

    jest.mock('../../error-handler', () => ({
      errorHandlerWrapper: mockErrorHandlerWrapper
    }));
  });

  const mockSteps = () => {
    mockGetGlobalConfiguration = jest
      .fn()
      .mockImplementation((_logger, rawData) => ({
        ...rawData,
        ...{
          globalConfiguration: {
            global: 'configuration data'
          }
        }
      }));

    mockGetTradingView = jest.fn().mockImplementation((_logger, rawData) => ({
      ...rawData,
      ...{
        tradingView: { tradingview: 'data' }
      }
    }));

    jest.mock('../trailingTradeIndicator/steps', () => ({
      getGlobalConfiguration: mockGetGlobalConfiguration,
      getTradingView: mockGetTradingView
    }));
  };

  describe('without any error', () => {
    beforeEach(async () => {
      mockSteps();

      const { execute: tradingViewExecute } = require('../tradingView');

      await tradingViewExecute(logger);
    });

    it('returns expected result', () => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        {
          data: {
            globalConfiguration: { global: 'configuration data' },
            tradingView: { tradingview: 'data' }
          }
        },
        'TradingView: Finish process...'
      );
    });
  });
});
