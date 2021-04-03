/* eslint-disable global-require */
const { logger } = require('../../../../helpers');

describe('get-symbol-configuration.js', () => {
  let rawData;

  let step;
  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    let mockGetConfiguration;

    beforeEach(async () => {
      mockGetConfiguration = jest.fn().mockResolvedValue({
        configuration: 'info'
      });

      jest.mock('../../../trailingTradeHelper/configuration', () => ({
        getConfiguration: mockGetConfiguration
      }));

      step = require('../get-symbol-configuration');

      rawData = { some: 'value' };
      result = await step.execute(logger, rawData);
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        some: 'value',
        symbolConfiguration: {
          configuration: 'info'
        }
      });
    });
  });
});
