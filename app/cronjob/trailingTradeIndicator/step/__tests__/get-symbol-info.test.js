/* eslint-disable global-require */
describe('get-symbol-info.js', () => {
  let result;
  let rawData;

  let loggerMock;
  let mockGetSymbolInfo;

  describe('execute', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();
    });

    beforeEach(async () => {
      const { logger } = require('../../../../helpers');

      loggerMock = logger;

      mockGetSymbolInfo = jest.fn().mockResolvedValue({
        symbol: 'info'
      });
      jest.mock('../../../trailingTradeHelper/common', () => ({
        getSymbolInfo: mockGetSymbolInfo
      }));

      rawData = {
        symbol: 'BTCUSDT',
        symbolInfo: {}
      };

      const step = require('../get-symbol-info');
      result = await step.execute(loggerMock, rawData);
    });

    it('triggers getSymbolInfo', () => {
      expect(mockGetSymbolInfo).toHaveBeenCalledWith(loggerMock, 'BTCUSDT');
    });

    it('retruns expected result', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        symbolInfo: {
          symbol: 'info'
        }
      });
    });
  });
});
