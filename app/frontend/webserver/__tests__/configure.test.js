/* eslint-disable global-require */

describe('webserver/configure.js', () => {
  const mockHandlers = {
    handleAuth: null,
    handle404: null
  };

  let cacheMock;
  let loggerMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockHandlers.handleAuth = jest.fn().mockResolvedValue(true);
    mockHandlers.handle404 = jest.fn().mockResolvedValue(true);

    jest.mock('../handlers', () => ({
      handleAuth: mockHandlers.handleAuth,
      handle404: mockHandlers.handle404
    }));
  });

  describe('when jwt token is not cached', () => {
    beforeEach(async () => {
      const { logger, cache } = require('../../../helpers');

      loggerMock = logger;
      cacheMock = cache;
      cacheMock.get = jest.fn().mockReturnValue(null);
      cacheMock.set = jest.fn().mockReturnValue(true);

      const { configureWebServer } = require('../configure');
      await configureWebServer('app', loggerMock);
    });

    it('triggers cache.get', () => {
      expect(cacheMock.get).toHaveBeenCalledWith('auth-jwt-secret');
    });

    it('triggers cache.set', () => {
      expect(cacheMock.set).toHaveBeenCalledWith(
        'auth-jwt-secret',
        expect.any(String)
      );
    });

    [
      {
        handlerFunc: 'handleAuth'
      },
      {
        handlerFunc: 'handle404'
      }
    ].forEach(t => {
      it(`triggers ${t.handlerFunc}`, () => {
        expect(mockHandlers[t.handlerFunc]).toHaveBeenCalledWith(
          loggerMock,
          'app'
        );
      });
    });
  });

  describe('when jwt token is cached', () => {
    beforeEach(async () => {
      const { logger, cache } = require('../../../helpers');

      loggerMock = logger;
      cacheMock = cache;
      cacheMock.get = jest.fn().mockReturnValue('uuid');
      cacheMock.set = jest.fn().mockReturnValue(true);

      const { configureWebServer } = require('../configure');
      await configureWebServer('app', loggerMock);
    });

    it('triggers cache.get', () => {
      expect(cacheMock.get).toHaveBeenCalledWith('auth-jwt-secret');
    });

    it('does not trigger cache.set', () => {
      expect(cacheMock.set).not.toHaveBeenCalled();
    });
  });
});
