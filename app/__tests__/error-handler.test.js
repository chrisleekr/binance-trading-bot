/* eslint-disable global-require */
describe('error-handler', () => {
  let config;

  let mockGetAPILimit;
  let mockLogger;
  let mockSlack;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    jest.mock('config');

    config = require('config');

    const { logger, slack } = require('../helpers');

    mockGetAPILimit = jest.fn().mockReturnValue(10);

    jest.mock('../cronjob/trailingTradeHelper/common', () => ({
      getAPILimit: mockGetAPILimit
    }));

    mockLogger = logger;

    mockSlack = slack;
    mockSlack.sendMessage = jest.fn().mockReturnValue(true);

    process.on = jest.fn().mockReturnValue(true);
  });

  describe('triggers process.on', () => {
    beforeEach(() => {
      const { runErrorHandler } = require('../error-handler');
      runErrorHandler(mockLogger);
    });

    it('with unhandledRejection', () => {
      expect(process.on).toHaveBeenCalledWith(
        'unhandledRejection',
        expect.any(Function)
      );
    });

    it('with uncaughtException', () => {
      expect(process.on).toHaveBeenCalledWith(
        'uncaughtException',
        expect.any(Function)
      );
    });
  });

  [
    {
      label: 'Error -1001',
      code: -1001,
      sendSlack: false,
      featureToggleNotifyDebug: false
    },
    {
      label: 'Error -1021',
      code: -1021,
      sendSlack: false,
      featureToggleNotifyDebug: true
    },
    {
      label: 'Error ECONNRESET',
      code: 'ECONNRESET',
      sendSlack: false,
      featureToggleNotifyDebug: false
    },
    {
      label: 'Error ECONNREFUSED',
      code: 'ECONNREFUSED',
      sendSlack: false,
      featureToggleNotifyDebug: true
    },
    {
      label: 'Error something else - with notify debug',
      code: 'something',
      sendSlack: true,
      featureToggleNotifyDebug: true
    },
    {
      label: 'Error something else - without notify debug',
      code: 'something',
      sendSlack: true,
      featureToggleNotifyDebug: false
    }
  ].forEach(errorInfo => {
    describe(`${errorInfo.label}`, () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          if (key === 'featureToggle.notifyDebug') {
            return errorInfo.featureToggleNotifyDebug;
          }
          return null;
        });

        process.on = jest.fn().mockImplementation((event, error) => {
          if (event === 'uncaughtException') {
            error({
              message: errorInfo.label,
              code: errorInfo.code,
              stack: errorInfo.code
            });
          }
        });

        const { runErrorHandler } = require('../error-handler');
        runErrorHandler(mockLogger);
      });

      if (errorInfo.sendSlack) {
        it('triggers slack.sendMessage', () => {
          expect(mockSlack.sendMessage).toHaveBeenCalled();
        });
      } else {
        it('does not trigger slack.sendMessage', () => {
          expect(mockSlack.sendMessage).not.toHaveBeenCalled();
        });
      }
    });
  });

  describe(`redlock error`, () => {
    beforeEach(async () => {
      process.on = jest.fn().mockImplementation((event, error) => {
        if (event === 'uncaughtException') {
          error({
            message: `redlock:bot-lock:XRPBUSD`,
            code: 500
          });
        }
      });

      const { runErrorHandler } = require('../error-handler');
      runErrorHandler(mockLogger);
    });

    it('do not trigger slack.sendMessagage', () => {
      expect(mockSlack.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe(`any warning received on unhandledRejection`, () => {
    it('do not trigger slack.sendMessage', async () => {
      expect(() => {
        process.on = jest.fn().mockImplementation((event, error) => {
          if (event === 'unhandledRejection') {
            error({
              message: `redlock:bot-lock:XRPBUSD`,
              code: 500
            });
          }
        });

        const { runErrorHandler } = require('../error-handler');
        runErrorHandler(mockLogger);
      }).toThrow(`redlock:bot-lock:XRPBUSD`);
    });
  });
});
