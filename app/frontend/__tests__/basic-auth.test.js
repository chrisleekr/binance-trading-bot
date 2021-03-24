/* eslint-disable global-require */
describe('basic-auth.js', () => {
  let config;
  let basicAuth;
  let otp;

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

    mockBasicAuthSafeCompare = jest.fn().mockImplementation((a, b) => a === b);

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

      mockBasicAuth = jest.fn().mockImplementation(() => ({
        safeCompare: mockBasicAuthSafeCompare
      }));

      jest.mock('express-basic-auth', () => mockBasicAuth);

      otp.verifyToken = jest.fn().mockReturnValue(false);
      mockExpressUse = jest.fn().mockImplementation(fn => fn());
      mockApp = {
        use: mockExpressUse
      };

      mockLogger.info = jest.fn().mockReturnValue(true);
      const { setBasicAuth } = require('../basic-auth');
      setBasicAuth(mockApp, mockLogger);
    });

    it('does not set app.use', () => {
      expect(mockExpressUse).not.toHaveBeenCalled({});
    });
  });

  describe('when authentication is enabled', () => {
    describe('when only username/password authentication is enabled', () => {
      describe('with invalid username', () => {});

      describe('with invalid password', () => {});

      describe('with valid username/password', () => {});
    });

    describe('when 2fa is enabled', () => {
      describe('with invalid username', () => {});

      describe('with invalid password ', () => {});

      describe('with invalid otp code ', () => {});

      describe('with valid username/password/otp code ', () => {});
    });
  });
});
