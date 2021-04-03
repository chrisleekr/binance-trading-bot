/* eslint-disable global-require */
const { logger } = require('../../../../helpers');

describe('get-global-configuration.js', () => {
  let rawData;

  let step;
  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    let mockGetGlobalConfiguration;

    beforeEach(async () => {
      mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
        configuration: 'info'
      });

      jest.mock('../../../trailingTradeHelper/configuration', () => ({
        getGlobalConfiguration: mockGetGlobalConfiguration
      }));

      step = require('../get-global-configuration');

      rawData = { some: 'value' };
      result = await step.execute(logger, rawData);
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        some: 'value',
        globalConfiguration: {
          configuration: 'info'
        }
      });
    });
  });
});
