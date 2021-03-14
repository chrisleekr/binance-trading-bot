/* eslint-disable global-require */
const { logger } = require('../../../../helpers');

describe('get-global-configuration.js', () => {
  let step;
  let result;
  let rawData;

  describe('execute', () => {
    let mockGetConfiguration;

    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockGetConfiguration = jest.fn().mockResolvedValue({ some: 'value' });

      jest.mock('../../configuration', () => ({
        getConfiguration: mockGetConfiguration
      }));

      step = require('../get-global-configuration');
      rawData = {};

      result = await step.execute(logger, rawData);
    });

    it('triggers getConfiguration', () => {
      expect(mockGetConfiguration).toHaveBeenCalled();
    });

    it('return expected result', () => {
      expect(result).toStrictEqual({
        globalConfiguration: {
          some: 'value'
        }
      });
    });
  });
});
