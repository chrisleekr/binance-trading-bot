/* eslint-disable global-require */
const { logger } = require('../../../../helpers');

describe('get-symbol-configuration.js', () => {
  let step;
  let result;
  let rawData;

  describe('execute', () => {
    let mockGetConfiguration;

    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockGetConfiguration = jest.fn().mockResolvedValue({ some: 'value' });

      jest.mock('../../../trailingTradeHelper/configuration', () => ({
        getConfiguration: mockGetConfiguration
      }));

      step = require('../get-symbol-configuration');
      rawData = {
        symbol: 'BTCUSDT'
      };

      result = await step.execute(logger, rawData);
    });

    it('triggers getConfiguration', () => {
      expect(mockGetConfiguration).toHaveBeenCalledWith(logger, 'BTCUSDT');
    });

    it('return expected result', () => {
      expect(result).toStrictEqual({
        symbol: 'BTCUSDT',
        symbolConfiguration: {
          some: 'value'
        }
      });
    });
  });
});
