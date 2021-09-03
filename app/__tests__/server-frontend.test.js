/* eslint-disable global-require */

describe('server-frontend', () => {
  let mockExpressStatic;
  let mockExpressUse;
  let mockExpressListen;
  let mockExpressServerOn;
  let mockExpressUrlEncoded;
  let mockExpressJson;
  let mockExpress;

  let mockCompression;
  let mockCors;

  let mockConfigureWebServer;
  let mockConfigureWebSocket;
  let mockConfigureLocalTunnel;

  let mockRateLimiterRedisGet;
  let mockRateLimiterRedis;

  let mockRequestIpGetClientIp;

  let mockRateLimiterMiddlewareReq;
  let mockRateLimiterMiddlewareResSend;
  let mockRateLimiterMiddlewareResStatus;
  let mockRateLimiterMiddlewareRes;
  let mockRateLimiterMiddlewareNext;

  let config;
  let cacheMock;
  let loggerMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    config = require('config');

    jest.mock('ws');
    jest.mock('config');

    mockCompression = jest.fn().mockReturnValue(true);
    mockCors = jest.fn().mockReturnValue(true);

    mockRateLimiterRedisGet = jest.fn().mockReturnValue({ remainingPoints: 5 });
    mockRateLimiterRedis = jest.fn().mockImplementation(() => ({
      get: mockRateLimiterRedisGet
    }));

    jest.mock('rate-limiter-flexible', () => ({
      RateLimiterRedis: mockRateLimiterRedis
    }));

    mockRequestIpGetClientIp = jest.fn().mockReturnValue('127.0.0.1');
    jest.mock('request-ip', () => ({
      getClientIp: mockRequestIpGetClientIp
    }));

    mockConfigureWebServer = jest.fn().mockReturnValue(true);
    mockConfigureWebSocket = jest.fn().mockReturnValue(true);
    mockConfigureLocalTunnel = jest.fn().mockReturnValue(true);

    mockExpressStatic = jest.fn().mockReturnValue(true);

    mockRateLimiterMiddlewareReq = 'req';

    mockRateLimiterMiddlewareResSend = jest.fn().mockReturnValue(true);
    mockRateLimiterMiddlewareResStatus = jest.fn().mockImplementation(() => ({
      send: mockRateLimiterMiddlewareResSend
    }));
    mockRateLimiterMiddlewareRes = {
      status: mockRateLimiterMiddlewareResStatus
    };

    mockRateLimiterMiddlewareNext = jest.fn().mockReturnValue(true);

    mockExpressUse = jest.fn().mockImplementation(async fn => {
      if (fn.name === 'compression') {
        mockCompression();
      } else if (fn.name === 'corsMiddleware') {
        mockCors();
      } else if (fn.name === 'rateLimiterMiddleware') {
        await fn(
          mockRateLimiterMiddlewareReq,
          mockRateLimiterMiddlewareRes,
          mockRateLimiterMiddlewareNext
        );
      }
    });
    mockExpressUrlEncoded = jest.fn().mockReturnValue(true);
    mockExpressJson = jest.fn().mockReturnValue(true);

    mockExpressListen = jest.fn().mockReturnValue({
      on: mockExpressServerOn
    });

    jest.mock('express', () => {
      mockExpress = () => ({
        use: mockExpressUse,
        listen: mockExpressListen
      });

      Object.defineProperty(mockExpress, 'static', {
        value: mockExpressStatic
      });

      Object.defineProperty(mockExpress, 'urlencoded', {
        value: mockExpressUrlEncoded
      });

      Object.defineProperty(mockExpress, 'json', {
        value: mockExpressJson
      });

      return mockExpress;
    });

    jest.mock('../frontend/webserver/configure', () => ({
      configureWebServer: mockConfigureWebServer
    }));

    jest.mock('../frontend/websocket/configure', () => ({
      configureWebSocket: mockConfigureWebSocket
    }));

    jest.mock('../frontend/local-tunnel/configure', () => ({
      configureLocalTunnel: mockConfigureLocalTunnel
    }));
  });

  describe('web server', () => {
    describe('authentication is disabled', () => {
      beforeEach(() => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'test';
            case 'authentication.enabled':
              return false;
            case 'authentication.loginLimiter.maxConsecutiveFails':
              return 5;
            case 'authentication.loginLimiter.duration':
              return 10800;
            case 'authentication.loginLimiter.blockDuration':
              return 900;
            default:
              return `value-${key}`;
          }
        });

        const { cache, logger } = require('../helpers');

        cacheMock = cache;
        cacheMock.redis = 'redis client';

        loggerMock = logger;

        const { runFrontend } = require('../server-frontend');
        runFrontend(logger);
      });

      it('initiates mockRateLimiterRedis', () => {
        expect(mockRateLimiterRedis).toHaveBeenCalledWith({
          redis: 'redis client',
          keyPrefix: 'login',
          points: 5,
          duration: 10800,
          blockDuration: 900
        });
      });

      it('triggers server.listen', () => {
        expect(mockExpressListen).toHaveBeenCalledWith(80);
      });

      it('triggers configureWebServer', () => {
        expect(mockConfigureWebServer).toHaveBeenCalledWith(
          expect.any(Object),
          loggerMock,
          { loginLimiter: expect.any(Object) }
        );
      });

      it('triggers configureWebSocket', () => {
        expect(mockConfigureWebSocket).toHaveBeenCalledWith(
          expect.any(Object),
          loggerMock,
          { loginLimiter: expect.any(Object) }
        );
      });

      it('does not trigger requestIp.getClientIp', () => {
        expect(mockRequestIpGetClientIp).not.toHaveBeenCalled();
      });

      it('does not trigger loginLimiter.get', () => {
        expect(mockRateLimiterRedisGet).not.toHaveBeenCalled();
      });

      it('triggers configureLocalTunnel', () => {
        expect(mockConfigureLocalTunnel).toHaveBeenCalled();
      });
    });

    describe('authentication is enabled', () => {
      beforeEach(() => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'test';
            case 'authentication.enabled':
              return true;
            case 'authentication.loginLimiter.maxConsecutiveFails':
              return 5;
            case 'authentication.loginLimiter.duration':
              return 10800;
            case 'authentication.loginLimiter.blockDuration':
              return 900;
            default:
              return `value-${key}`;
          }
        });

        const { cache, logger } = require('../helpers');

        cacheMock = cache;
        cacheMock.redis = 'redis client';

        loggerMock = logger;
      });

      describe('remaining points are more than 0', () => {
        beforeEach(() => {
          mockRateLimiterRedisGet = jest
            .fn()
            .mockReturnValue({ remainingPoints: 5 });
          mockRateLimiterRedis = jest.fn().mockImplementation(() => ({
            get: mockRateLimiterRedisGet
          }));

          jest.mock('rate-limiter-flexible', () => ({
            RateLimiterRedis: mockRateLimiterRedis
          }));

          const { runFrontend } = require('../server-frontend');
          runFrontend(loggerMock);
        });

        it('triggers requestIp.getClientIp', () => {
          expect(mockRequestIpGetClientIp).toHaveBeenCalled();
        });

        it('triggers loginLimiter.get', () => {
          expect(mockRateLimiterRedisGet).toHaveBeenCalledWith('127.0.0.1');
        });

        it('does not trigger status', () => {
          expect(mockRateLimiterMiddlewareResStatus).not.toHaveBeenCalled();
        });

        it('triggers next', () => {
          expect(mockRateLimiterMiddlewareNext).toHaveBeenCalled();
        });
      });

      describe('remaining point is less or equal than 0', () => {
        beforeEach(() => {
          mockRateLimiterRedisGet = jest
            .fn()
            .mockReturnValue({ remainingPoints: 0 });
          mockRateLimiterRedis = jest.fn().mockImplementation(() => ({
            get: mockRateLimiterRedisGet
          }));

          jest.mock('rate-limiter-flexible', () => ({
            RateLimiterRedis: mockRateLimiterRedis
          }));

          const { runFrontend } = require('../server-frontend');
          runFrontend(loggerMock);
        });

        it('triggers requestIp.getClientIp', () => {
          expect(mockRequestIpGetClientIp).toHaveBeenCalled();
        });

        it('triggers loginLimiter.get', () => {
          expect(mockRateLimiterRedisGet).toHaveBeenCalledWith('127.0.0.1');
        });

        it('triggers status', () => {
          expect(mockRateLimiterMiddlewareResStatus).toHaveBeenCalledWith(403);
        });

        it('triggers send', () => {
          expect(mockRateLimiterMiddlewareResSend).toHaveBeenCalledWith(
            expect.stringContaining(`You are blocked`)
          );
        });

        it('does not trigger next', () => {
          expect(mockRateLimiterMiddlewareNext).not.toHaveBeenCalled();
        });
      });
    });
  });
});
