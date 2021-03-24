/* eslint-disable global-require */

describe('basic-auth.js', () => {
  let config;
  let otp;
  let fs;

  let mockLogger;
  let mockApp;
  let mockExpressUse;
  let mockBasicAuth;
  let mockBasicAuthSafeCompare;

  let result;
  beforeEach(() => {
    jest.clearAllMocks().resetModules();
    const { logger } = require('../../helpers');
    mockLogger = logger;

    otp = require('node-2fa');
  });

  describe('when authentication is not enabled', () => {
    beforeEach(() => {
      config = require('config');
      jest.mock('config');

      config.get = jest.fn(key => {
        switch (key) {
          case 'frontend.auth.enabled':
            return false;
          case 'frontend.auth.twoFAEnabled':
            return true;
          case 'frontend.auth.username':
            return 'my-username';
          case 'frontend.auth.password':
            return 'my-password';
          default:
            return `value-${key}`;
        }
      });

      mockBasicAuthSafeCompare = jest
        .fn()
        .mockImplementation((a, b) => a === b);
      mockBasicAuth = jest.fn();
      mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

      jest.mock('express-basic-auth', () => mockBasicAuth);

      otp.verifyToken = jest.fn().mockReturnValue(null);
      mockExpressUse = jest.fn().mockImplementation(fn => fn());
      mockApp = {
        use: mockExpressUse
      };

      mockLogger.info = jest.fn().mockReturnValue(true);
      const { setBasicAuth } = require('../basic-auth');
      setBasicAuth(mockApp, mockLogger);
    });

    it('does not set app.use', () => {
      expect(mockExpressUse).not.toHaveBeenCalled();
    });
  });

  describe('when authentication is enabled', () => {
    describe('when only username/password authentication is enabled', () => {
      describe('with invalid username', () => {
        beforeEach(() => {
          config = require('config');
          jest.mock('config');

          config.get = jest.fn(key => {
            switch (key) {
              case 'frontend.auth.enabled':
                return true;
              case 'frontend.auth.twoFAEnabled':
                return false;
              case 'frontend.auth.username':
                return 'my-username';
              case 'frontend.auth.password':
                return 'my-password';
              default:
                return `value-${key}`;
            }
          });

          mockBasicAuthSafeCompare = jest
            .fn()
            .mockImplementation((a, b) => a === b);
          mockBasicAuth = jest.fn();
          mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

          jest.mock('express-basic-auth', () => mockBasicAuth);

          otp.verifyToken = jest.fn().mockReturnValue(null);
          mockExpressUse = jest.fn().mockReturnValue(true);
          mockApp = {
            use: mockExpressUse
          };

          mockLogger.info = jest.fn().mockReturnValue(true);
          const { setBasicAuth } = require('../basic-auth');
          setBasicAuth(mockApp, mockLogger);
          // Execute authorizer
          result = mockBasicAuth.mock.calls[0][0].authorizer(
            'invalid-username',
            'my-password'
          );
        });

        it('sets app.use', () => {
          expect(mockExpressUse).toHaveBeenCalled();
        });

        it('triggers basicAuth with expected options', () => {
          expect(mockBasicAuth.mock.calls[0][0]).toStrictEqual({
            authorizer: expect.any(Function),
            challenge: true,
            realm: 'Binance Trading Bot'
          });
        });

        it('triggers basicAuth.safeCompare with username', () => {
          expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
            'invalid-username',
            'my-username'
          );
        });

        it('does not trigger verify token', () => {
          expect(otp.verifyToken).not.toHaveBeenCalled();
        });

        it('triggers basicAuth.safeCompare with password', () => {
          expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
            'my-password',
            'my-password'
          );
        });

        it('returns expected result', () => {
          expect(result).toBeFalsy();
        });
      });

      describe('with invalid password', () => {
        beforeEach(() => {
          config = require('config');
          jest.mock('config');

          config.get = jest.fn(key => {
            switch (key) {
              case 'frontend.auth.enabled':
                return true;
              case 'frontend.auth.twoFAEnabled':
                return false;
              case 'frontend.auth.username':
                return 'my-username';
              case 'frontend.auth.password':
                return 'my-password';
              default:
                return `value-${key}`;
            }
          });

          mockBasicAuthSafeCompare = jest
            .fn()
            .mockImplementation((a, b) => a === b);
          mockBasicAuth = jest.fn();
          mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

          jest.mock('express-basic-auth', () => mockBasicAuth);

          otp.verifyToken = jest.fn().mockReturnValue(null);
          mockExpressUse = jest.fn().mockReturnValue(true);
          mockApp = {
            use: mockExpressUse
          };

          mockLogger.info = jest.fn().mockReturnValue(true);
          const { setBasicAuth } = require('../basic-auth');
          setBasicAuth(mockApp, mockLogger);
          // Execute authorizer
          result = mockBasicAuth.mock.calls[0][0].authorizer(
            'my-username',
            'invalid-password'
          );
        });

        it('triggers basicAuth.safeCompare with username', () => {
          expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
            'my-username',
            'my-username'
          );
        });

        it('does not trigger verify token', () => {
          expect(otp.verifyToken).not.toHaveBeenCalled();
        });

        it('triggers basicAuth.safeCompare with password', () => {
          expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
            'invalid-password',
            'my-password'
          );
        });

        it('returns expected result', () => {
          expect(result).toBeFalsy();
        });
      });

      describe('with valid username/password', () => {
        beforeEach(() => {
          config = require('config');
          jest.mock('config');

          config.get = jest.fn(key => {
            switch (key) {
              case 'frontend.auth.enabled':
                return true;
              case 'frontend.auth.twoFAEnabled':
                return false;
              case 'frontend.auth.username':
                return 'my-username';
              case 'frontend.auth.password':
                return 'my-password';
              default:
                return `value-${key}`;
            }
          });

          mockBasicAuthSafeCompare = jest
            .fn()
            .mockImplementation((a, b) => a === b);
          mockBasicAuth = jest.fn();
          mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

          jest.mock('express-basic-auth', () => mockBasicAuth);

          otp.verifyToken = jest.fn().mockReturnValue(null);
          mockExpressUse = jest.fn().mockReturnValue(true);
          mockApp = {
            use: mockExpressUse
          };

          mockLogger.info = jest.fn().mockReturnValue(true);
          const { setBasicAuth } = require('../basic-auth');
          setBasicAuth(mockApp, mockLogger);
          // Execute authorizer
          result = mockBasicAuth.mock.calls[0][0].authorizer(
            'my-username',
            'my-password'
          );
        });

        it('triggers basicAuth.safeCompare with username', () => {
          expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
            'my-username',
            'my-username'
          );
        });

        it('does not trigger verify token', () => {
          expect(otp.verifyToken).not.toHaveBeenCalled();
        });

        it('triggers basicAuth.safeCompare with password', () => {
          expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
            'my-password',
            'my-password'
          );
        });

        it('returns expected result', () => {
          expect(result).toBeTruthy();
        });
      });
    });

    describe('when 2fa is enabled', () => {
      describe('without 2fa_secret file', () => {
        describe('with invalid username', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue(null);
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'invalid-username',
              'my-password'
            );
          });

          it('sets app.use', () => {
            expect(mockExpressUse).toHaveBeenCalled();
          });

          it('triggers basicAuth with expected options', () => {
            expect(mockBasicAuth.mock.calls[0][0]).toStrictEqual({
              authorizer: expect.any(Function),
              challenge: true,
              realm: 'Binance Trading Bot - 2FA'
            });
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'invalid-username',
              'my-username'
            );
          });

          it('does not trigger verify token because 2fa_secret file does not exist', () => {
            expect(otp.verifyToken).not.toHaveBeenCalled();
          });

          it('triggers basicAuth.safeCompare with password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-password',
              'my-password'
            );
          });

          it('returns expected result', () => {
            expect(result).toBeFalsy();
          });
        });

        describe('with invalid password', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue(null);
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'my-username',
              'invalid-password'
            );
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-username',
              'my-username'
            );
          });

          it('does not trigger verify token because 2fa_secret file does not exist', () => {
            expect(otp.verifyToken).not.toHaveBeenCalled();
          });

          it('triggers basicAuth.safeCompare with password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'invalid-password',
              'my-password'
            );
          });

          it('returns expected result', () => {
            expect(result).toBeFalsy();
          });
        });

        describe('with valid username/password, but without otp code', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue(null);
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'my-username',
              'my-password'
            );
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-username',
              'my-username'
            );
          });

          it('does not trigger verify token because 2fa_secret file does not exist', () => {
            expect(otp.verifyToken).not.toHaveBeenCalled();
          });

          it('triggers basicAuth.safeCompare with password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-password',
              'my-password'
            );
          });

          it('returns expected result', () => {
            expect(result).toBeTruthy();
          });
        });

        describe('with valid username/password/otp code', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue(null);
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'my-username',
              'my-password123456'
            );
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-username',
              'my-username'
            );
          });

          it('does not trigger verify token because 2fa_secret file does not exist', () => {
            expect(otp.verifyToken).not.toHaveBeenCalled();
          });

          it('triggers basicAuth.safeCompare with password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-password123456',
              'my-password'
            );
          });

          it('returns expected result', () => {
            expect(result).toBeFalsy();
          });
        });
      });

      describe('with 2fa_secret file', () => {
        beforeEach(() => {
          jest.mock('fs');

          fs = require('fs');
          fs.existsSync = jest.fn().mockReturnValue(true);
          fs.readFileSync = jest.fn().mockReturnValue('otp-secret');
        });

        describe('with valid username/password, but without otp code', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue(null);
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'my-username',
              'my-password'
            );
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-username',
              'my-username'
            );
          });

          it('triggers basicAuth.safeCompare with cutted password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-pa',
              'my-password'
            );
          });

          it('triggers verify token', () => {
            expect(otp.verifyToken).toHaveBeenCalledWith('otp-secret', '');
          });

          it('returns expected result', () => {
            expect(result).toBeFalsy();
          });
        });

        describe('with valid username/password, but invalid otp code', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue(null);
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'my-username',
              'my-password999999'
            );
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-username',
              'my-username'
            );
          });

          it('triggers basicAuth.safeCompare with cutted password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-password',
              'my-password'
            );
          });

          it('triggers verify token', () => {
            expect(otp.verifyToken).toHaveBeenCalledWith(
              'otp-secret',
              '999999'
            );
          });

          it('returns expected result', () => {
            expect(result).toBeFalsy();
          });
        });

        describe('with valid username/password/otp code', () => {
          beforeEach(() => {
            config = require('config');
            jest.mock('config');

            config.get = jest.fn(key => {
              switch (key) {
                case 'frontend.auth.enabled':
                  return true;
                case 'frontend.auth.twoFAEnabled':
                  return true;
                case 'frontend.auth.username':
                  return 'my-username';
                case 'frontend.auth.password':
                  return 'my-password';
                default:
                  return `value-${key}`;
              }
            });

            mockBasicAuthSafeCompare = jest
              .fn()
              .mockImplementation((a, b) => a === b);
            mockBasicAuth = jest.fn();
            mockBasicAuth.safeCompare = mockBasicAuthSafeCompare;

            jest.mock('express-basic-auth', () => mockBasicAuth);

            otp.verifyToken = jest.fn().mockReturnValue({
              delta: 0
            });
            mockExpressUse = jest.fn().mockReturnValue(true);
            mockApp = {
              use: mockExpressUse
            };

            mockLogger.info = jest.fn().mockReturnValue(true);
            const { setBasicAuth } = require('../basic-auth');
            setBasicAuth(mockApp, mockLogger);
            // Execute authorizer
            result = mockBasicAuth.mock.calls[0][0].authorizer(
              'my-username',
              'my-password123456'
            );
          });

          it('triggers basicAuth.safeCompare with username', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-username',
              'my-username'
            );
          });

          it('triggers basicAuth.safeCompare with cutted password', () => {
            expect(mockBasicAuthSafeCompare).toHaveBeenCalledWith(
              'my-password',
              'my-password'
            );
          });

          it('triggers verify token', () => {
            expect(otp.verifyToken).toHaveBeenCalledWith(
              'otp-secret',
              '123456'
            );
          });

          it('returns expected result', () => {
            expect(result).toBeTruthy();
          });
        });
      });
    });
  });
});
