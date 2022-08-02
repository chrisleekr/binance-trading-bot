/* eslint-disable global-require */
// eslint-disable-next-line max-classes-per-file
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

  describe('errorHandlerWrapper', () => {
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

          const { errorHandlerWrapper } = require('../error-handler');
          await errorHandlerWrapper(mockLogger, 'WhateverJob', () => {
            throw new (class CustomError extends Error {
              constructor() {
                super();
                this.code = errorInfo.code;
                this.message = `${errorInfo.code}`;
              }
            })();
          });
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
        config.get = jest.fn(_key => null);

        const { errorHandlerWrapper } = require('../error-handler');
        await errorHandlerWrapper(mockLogger, 'WhateverJob', () => {
          throw new (class CustomError extends Error {
            constructor() {
              super();
              this.code = 500;
              this.message = `redlock:lock-XRPBUSD`;
            }
          })();
        });
      });

      it('do not trigger slack.sendMessagage', () => {
        expect(mockSlack.sendMessage).not.toHaveBeenCalled();
      });
    });
  });

  describe('runErrorHandler', () => {
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

    describe(`when uncaughtException received without notifyDebug`, () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          if (key === 'featureToggle.notifyDebug') {
            return false;
          }
          return null;
        });

        process.on = jest.fn().mockImplementation((event, error) => {
          if (event === 'uncaughtException') {
            error({
              message: `something-unexpected`,
              code: 1000
            });
          }
        });

        const { runErrorHandler } = require('../error-handler');
        runErrorHandler(mockLogger);
      });

      it('triggers slack.sendMessage', () => {
        expect(mockSlack.sendMessage).toHaveBeenCalled();
      });
    });

    describe(`when uncaughtException received with notifyDebug`, () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          if (key === 'featureToggle.notifyDebug') {
            return true;
          }
          return null;
        });

        process.on = jest.fn().mockImplementation((event, error) => {
          if (event === 'uncaughtException') {
            error({
              message: `something-unexpected`,
              code: 1000
            });
          }
        });

        const { runErrorHandler } = require('../error-handler');
        runErrorHandler(mockLogger);
      });

      it('triggers slack.sendMessage', () => {
        expect(mockSlack.sendMessage).toHaveBeenCalled();
      });
    });

    describe(`when unhandledRejection received`, () => {
      it('throws an error', async () => {
        expect(() => {
          process.on = jest.fn().mockImplementation((event, error) => {
            if (event === 'unhandledRejection') {
              error({
                message: `something-unhandled`,
                code: 2000
              });
            }
          });

          const { runErrorHandler } = require('../error-handler');
          runErrorHandler(mockLogger);
        }).toThrow(`something-unhandled`);
      });
    });
  });
});
