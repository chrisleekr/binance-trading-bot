/* eslint-disable global-require */
const { logger } = require('../../../../helpers');

describe('get-account-info.js', () => {
  let rawData;

  let step;
  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    let mockGetAccountInfoFromAPI;

    beforeEach(async () => {
      mockGetAccountInfoFromAPI = jest.fn().mockResolvedValue({
        account: 'info'
      });

      jest.mock('../../../trailingTradeHelper/common', () => ({
        getAccountInfoFromAPI: mockGetAccountInfoFromAPI
      }));

      step = require('../get-account-info');

      rawData = { some: 'value' };
      result = await step.execute(logger, rawData);
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        some: 'value',
        accountInfo: {
          account: 'info'
        }
      });
    });
  });
});
