/* eslint-disable global-require */

describe('local-tunnel/configure.js', () => {
  let config;

  let localTunnel;
  let mockLogger;
  let mockCache;
  let mockSlack;

  let mockLocalTunnelOnClose;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    jest.useFakeTimers();

    const { logger, cache, slack } = require('../../helpers');

    mockLogger = logger;
    mockCache = cache;
    mockSlack = slack;

    config = require('config');
    jest.mock('config');

    config.get = jest.fn(key => {
      switch (key) {
        case 'mode':
          return 'test';
        case 'localTunnel.enabled':
          return true;
        case 'localTunnel.subdomain':
          return 'my-domain';
        default:
          return `value-${key}`;
      }
    });

    mockSlack.sendMessage = jest.fn();

    mockCache.hset = jest.fn().mockResolvedValue(true);

    mockLocalTunnelOnClose = jest.fn().mockImplementation((_event, cb) => {
      cb();
    });
  });

  describe('when local tunnel is disabled', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'mode':
            return 'test';
          case 'localTunnel.enabled':
            return false;
          case 'localTunnel.subdomain':
            return 'my-domain';
          default:
            return `value-${key}`;
        }
      });
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return undefined;
        }

        return '';
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOnClose
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);
    });

    it('does not initalise', () => {
      expect(localTunnel).not.toHaveBeenCalled();
    });
  });

  describe('when local tunnel url is not cached', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return undefined;
        }

        return '';
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOnClose
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);
    });

    it('initalise with expected', () => {
      expect(localTunnel).toHaveBeenCalledWith({
        port: 80,
        subdomain: 'my-domain'
      });
    });

    it('triggers cache.hget', () => {
      expect(mockCache.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'local-tunnel-url'
      );
    });

    it('triggers cache.hset', () => {
      expect(mockCache.hset).toHaveBeenCalledWith(
        'trailing-trade-common',
        'local-tunnel-url',
        'my-domain.loca.lt'
      );
    });
  });

  describe('when local tunnel url is cached, but new url is different', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'different-domain.loca.lt',
          on: mockLocalTunnelOnClose
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);
    });

    it('initalise with expected', () => {
      expect(localTunnel).toHaveBeenCalledWith({
        port: 80,
        subdomain: 'my-domain'
      });
    });

    it('triggers cache.hget', () => {
      expect(mockCache.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'local-tunnel-url'
      );
    });

    it('triggers cache.hset', () => {
      expect(mockCache.hset).toHaveBeenCalledWith(
        'trailing-trade-common',
        'local-tunnel-url',
        'different-domain.loca.lt'
      );
    });
  });

  describe('when local tunnel url is cached and new url is same', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'old-domain.loca.lt',
          on: mockLocalTunnelOnClose
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      mockLocalTunnelOnClose = jest
        .fn()
        .mockImplementation((_event, _cb) => {});

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'old-domain.loca.lt',
          on: mockLocalTunnelOnClose
        }))
      );

      jest.runOnlyPendingTimers();
    });

    it('initalise with expected', () => {
      expect(localTunnel).toHaveBeenCalledWith({
        port: 80,
        subdomain: 'my-domain'
      });
    });

    it('triggers cache.hget', () => {
      expect(mockCache.hget).toHaveBeenCalledWith(
        'trailing-trade-common',
        'local-tunnel-url'
      );
    });

    it('does not trigger cache.hset', () => {
      expect(mockCache.hset).not.toHaveBeenCalled();
    });
  });
});
