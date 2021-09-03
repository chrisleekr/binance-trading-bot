/* eslint-disable global-require */
describe('webserver/handlers/auth', () => {
  let config;
  let jwt;

  let cacheMock;
  let PubSubMock;
  let loggerMock;

  let mockRequestIpGetClientIp;

  let mockLoginLimiterDelete;
  let mockLoginLimiterConsume;
  let mockLoginLimiter;

  let resSendMock;

  const appMock = {
    route: null
  };

  let postReq;

  let mockGetGlobalConfiguration;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    config = require('config');
    jwt = require('jsonwebtoken');

    jest.mock('config');
    jest.mock('jsonwebtoken');

    jwt.sign = jest.fn().mockResolvedValue('authToken');

    resSendMock = jest.fn().mockResolvedValue(true);
    appMock.route = jest.fn(() => ({
      post: jest.fn().mockImplementation(func => {
        func(postReq, { send: resSendMock });
      })
    }));
    config.get = jest.fn(key => {
      switch (key) {
        case 'authentication.password':
          return '123456';
        default:
      }
      return null;
    });

    mockGetGlobalConfiguration = jest.fn().mockResolvedValue({
      botOptions: {
        authentication: {
          lockAfter: 120
        }
      }
    });

    mockRequestIpGetClientIp = jest.fn().mockReturnValue('127.0.0.1');
    jest.mock('request-ip', () => ({
      getClientIp: mockRequestIpGetClientIp
    }));

    mockLoginLimiterDelete = jest.fn().mockResolvedValue(true);
    mockLoginLimiterConsume = jest.fn().mockResolvedValue(true);
    mockLoginLimiter = {
      consume: mockLoginLimiterConsume,
      delete: mockLoginLimiterDelete
    };

    jest.mock('../../../../cronjob/trailingTradeHelper/configuration', () => ({
      getGlobalConfiguration: mockGetGlobalConfiguration
    }));
  });

  describe('when verification failed', () => {
    [
      {
        password: null
      },
      {
        password: undefined
      },
      {
        password: ''
      },
      {
        password: 'not-valid'
      },
      {
        password: 456789
      }
    ].forEach(t => {
      describe(`password: ${t.password}`, () => {
        beforeEach(async () => {
          const { logger, PubSub, cache } = require('../../../../helpers');

          loggerMock = logger;

          PubSubMock = PubSub;
          PubSubMock.publish = jest.fn().mockResolvedValue(true);

          cacheMock = cache;
          cacheMock.get = jest.fn().mockResolvedValue('uuid');

          postReq = {
            body: {
              password: t.password
            }
          };
          const { handleAuth } = require('../auth');
          await handleAuth(loggerMock, appMock, {
            loginLimiter: mockLoginLimiter
          });
        });

        it('triggers PubSub.publish', () => {
          expect(PubSubMock.publish).toHaveBeenCalledWith(
            'frontend-notification',
            {
              type: 'error',
              title: 'Sorry, please enter correct password.'
            }
          );
        });

        it('triggers loginLimiter.consume', () => {
          expect(mockLoginLimiterConsume).toHaveBeenCalledWith('127.0.0.1');
        });

        it('does not trigger loginLimiter.delete', () => {
          expect(mockLoginLimiterDelete).not.toHaveBeenCalled();
        });

        it('return unauthorised', () => {
          expect(resSendMock).toHaveBeenCalledWith({
            success: false,
            status: 401,
            message: 'Unauthorized',
            data: {
              authToken: ''
            }
          });
        });
      });
    });
  });

  describe('when verification succeed', () => {
    beforeEach(async () => {
      const { logger, PubSub, cache } = require('../../../../helpers');

      loggerMock = logger;

      PubSubMock = PubSub;
      PubSubMock.publish = jest.fn().mockResolvedValue(true);

      cacheMock = cache;
      cacheMock.get = jest.fn().mockResolvedValue('uuid');

      postReq = {
        body: {
          password: '123456'
        }
      };
      const { handleAuth } = require('../auth');
      await handleAuth(loggerMock, appMock, { loginLimiter: mockLoginLimiter });
    });

    it('triggers PubSub.publish', () => {
      expect(PubSubMock.publish).toHaveBeenCalledWith('frontend-notification', {
        type: 'success',
        title: 'You are authenticated.'
      });
    });

    it('does not trigger loginLimiter.consume', () => {
      expect(mockLoginLimiterConsume).not.toHaveBeenCalled();
    });

    it('triggers loginLimiter.delete', () => {
      expect(mockLoginLimiterDelete).toHaveBeenCalledWith('127.0.0.1');
    });

    it('return unauthorised', () => {
      expect(resSendMock).toHaveBeenCalledWith({
        success: true,
        status: 200,
        message: 'Authorized',
        data: {
          authToken: 'authToken'
        }
      });
    });
  });
});
