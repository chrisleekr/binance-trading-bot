/* eslint-disable global-require */

describe('webserver/configure.js', () => {
  let mockSetHandlers;

  let cacheMock;
  let loggerMock;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    mockSetHandlers = jest.fn().mockResolvedValue(true);

    jest.mock('../handlers', () => ({
      setHandlers: mockSetHandlers
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

    it(`triggers setHandlers`, () => {
      expect(mockSetHandlers).toHaveBeenCalledWith(loggerMock, 'app');
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
