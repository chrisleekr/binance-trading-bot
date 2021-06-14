/* eslint-disable global-require */

describe('execute-dust-transfer.js', () => {
  let loggerMock;
  let binanceMock;
  let PubSubMock;

  let rawData;

  let step;
  let result;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
  });

  describe('execute', () => {
    describe('if action is not dust-transfer', () => {
      beforeEach(async () => {
        const { binance, PubSub, logger } = require('../../../../helpers');

        loggerMock = logger;
        binanceMock = binance;
        PubSubMock = PubSub;

        PubSubMock.publish = jest.fn().mockResolvedValue(true);
        binanceMock.client.dustTransfer = jest.fn().mockResolvedValue(true);

        step = require('../execute-dust-transfer');

        rawData = {
          action: 'something-else'
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('does not trigger binance.client.dustTransfer', () => {
        expect(binanceMock.client.dustTransfer).not.toHaveBeenCalled();
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          action: 'something-else'
        });
      });
    });
  });

  describe('if action is dust-transfer', () => {
    describe('when successfully executed', () => {
      beforeEach(async () => {
        const { binance, PubSub, logger } = require('../../../../helpers');

        loggerMock = logger;
        binanceMock = binance;
        PubSubMock = PubSub;

        PubSubMock.publish = jest.fn().mockResolvedValue(true);
        binanceMock.client.dustTransfer = jest.fn().mockResolvedValue(true);

        step = require('../execute-dust-transfer');

        rawData = {
          action: 'dust-transfer',
          overrideParams: [
            {
              asset: 'ETH',
              checked: false
            },
            {
              asset: 'LTC',
              checked: true
            },
            {
              asset: 'TRX',
              checked: true
            },
            {
              asset: 'XRP',
              checked: false
            }
          ]
        };

        result = await step.execute(loggerMock, rawData);
      });

      it('trigger binance.client.dustTransfer', () => {
        expect(binanceMock.client.dustTransfer).toHaveBeenCalledWith({
          asset: ['LTC', 'TRX']
        });
      });

      it('triggers PubSubMock.publish', () => {
        expect(PubSubMock.publish).toHaveBeenCalledWith(
          'frontend-notification',
          {
            type: 'success',
            title:
              'The dust transfer has been executed successfully. The account information will be updated soon.'
          }
        );
      });

      it('retruns expected data', () => {
        expect(result).toStrictEqual({
          action: 'dust-transfer',
          overrideParams: [
            {
              asset: 'ETH',
              checked: false
            },
            {
              asset: 'LTC',
              checked: true
            },
            {
              asset: 'TRX',
              checked: true
            },
            {
              asset: 'XRP',
              checked: false
            }
          ]
        });
      });
    });
  });

  describe('when failed executed', () => {
    beforeEach(async () => {
      const { binance, PubSub, logger } = require('../../../../helpers');

      loggerMock = logger;
      binanceMock = binance;
      PubSubMock = PubSub;

      PubSubMock.publish = jest.fn().mockResolvedValue(true);
      binanceMock.client.dustTransfer = jest
        .fn()
        .mockRejectedValue(new Error('failed'));

      step = require('../execute-dust-transfer');

      rawData = {
        action: 'dust-transfer',
        overrideParams: [
          {
            asset: 'ETH',
            checked: false
          },
          {
            asset: 'LTC',
            checked: true
          },
          {
            asset: 'TRX',
            checked: true
          },
          {
            asset: 'XRP',
            checked: false
          }
        ]
      };

      result = await step.execute(loggerMock, rawData);
    });

    it('trigger binance.client.dustTransfer', () => {
      expect(binanceMock.client.dustTransfer).toHaveBeenCalledWith({
        asset: ['LTC', 'TRX']
      });
    });

    it('triggers PubSubMock.publish', () => {
      expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
        type: 'error',
        title: `The dust transfer is failed to execute. Try again later.`
      });
    });

    it('retruns expected data', () => {
      expect(result).toStrictEqual({
        action: 'dust-transfer',
        overrideParams: [
          {
            asset: 'ETH',
            checked: false
          },
          {
            asset: 'LTC',
            checked: true
          },
          {
            asset: 'TRX',
            checked: true
          },
          {
            asset: 'XRP',
            checked: false
          }
        ]
      });
    });
  });
});
