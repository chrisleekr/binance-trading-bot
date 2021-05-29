/* eslint-disable global-require */

describe('local-tunnel/configure.js', () => {
  let config;

  let localTunnel;
  let mockLogger;
  let mockCache;
  let mockSlack;

  let mockLocalTunnelOn;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    jest.useFakeTimers();

    const { logger, cache, slack } = require('../../../helpers');

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
        case 'featureToggle.notifyDebug':
          return false;
        default:
          return `value-${key}`;
      }
    });

    mockSlack.sendMessage = jest.fn();

    mockCache.hset = jest.fn().mockResolvedValue(true);
    mockCache.hdel = jest.fn().mockResolvedValue(true);

    mockLocalTunnelOn = jest.fn().mockImplementation((_event, _cb) => {});
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
          on: mockLocalTunnelOn
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

  describe('when local tunnel url is not cached and returned configured domain', () => {
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
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);
      jest.advanceTimersByTime(300 * 1000);
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

    it('calls localTunnel only once', () => {
      expect(localTunnel).toHaveBeenCalledTimes(1);
    });
  });

  describe('when local tunnel url is cached and new url is different. Also it is not configured domain', () => {
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
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      // 120
      jest.advanceTimersByTime(60 * 60 * 1000);
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

    it('calls localTunnel two times', () => {
      expect(localTunnel).toHaveBeenCalledTimes(2);
    });
  });

  describe(
    `when local tunnel url is cached and new url is same. ` +
      `But still not configured domain (notifyDebug enabled)`,
    () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'mode':
              return 'test';
            case 'localTunnel.enabled':
              return true;
            case 'localTunnel.subdomain':
              return 'my-domain';
            case 'featureToggle.notifyDebug':
              return true;
            default:
              return `value-${key}`;
          }
        });

        mockCache.hget = jest.fn().mockImplementation((key, field) => {
          if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
            return 'old-domain.loca.lt';
          }

          return '';
        });

        mockLocalTunnelOn = jest.fn().mockImplementation((_event, _cb) => {});

        jest.mock('localtunnel', () =>
          jest.fn().mockImplementation(() => ({
            url: 'old-domain.loca.lt',
            on: mockLocalTunnelOn
          }))
        );

        localTunnel = require('localtunnel');

        const { configureLocalTunnel } = require('../configure');

        await configureLocalTunnel(mockLogger);

        // 120
        jest.advanceTimersByTime(60 * 60 * 1000);
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

      it('calls localTunnel two times', () => {
        expect(localTunnel).toHaveBeenCalledTimes(2);
      });

      it('calls slack.sendMessage', () => {
        expect(mockSlack.sendMessage).toHaveBeenCalled();
      });
    }
  );

  describe('when local tunnel url is cached and new url is same. And returned configured domain', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      mockLocalTunnelOn = jest.fn().mockImplementation((_event, _cb) => {});

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      // 120
      jest.advanceTimersByTime(60 * 60 * 1000);
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

    it('calls localTunnel one time', () => {
      expect(localTunnel).toHaveBeenCalledTimes(1);
    });
  });

  describe('when local tunnel throws an error', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      mockLocalTunnelOn = jest.fn().mockImplementation((_event, _cb) => {});

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => {
          throw new Error('something happened');
        })
      );

      // 120
      jest.advanceTimersByTime(60 * 60 * 1000);
    });

    it('initalise with expected', () => {
      expect(localTunnel).toHaveBeenCalledWith({
        port: 80,
        subdomain: 'my-domain'
      });
    });

    it('does not trigger cache.hget', () => {
      expect(mockCache.hget).not.toHaveBeenCalled();
    });

    it('does not trigger cache.hset', () => {
      expect(mockCache.hset).not.toHaveBeenCalled();
    });

    it('calls localTunnel two times', () => {
      expect(localTunnel).toHaveBeenCalledTimes(2);
    });
  });

  describe('when local tunnel invoke an error event', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      mockLocalTunnelOn = jest.fn().mockImplementation((event, cb) => {
        if (event === 'error') {
          cb();
        }
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      // 120
      jest.advanceTimersByTime(60 * 60 * 1000);
    });

    it('calls localTunnel two times', () => {
      expect(localTunnel).toHaveBeenCalledTimes(2);
    });
  });

  describe('when local tunnel invoke a close event', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      mockLocalTunnelOn = jest.fn().mockImplementation((event, cb) => {
        if (event === 'close') {
          cb();
        }
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      // 120
      jest.advanceTimersByTime(60 * 60 * 1000);
    });

    it('calls localTunnel two times', () => {
      expect(localTunnel).toHaveBeenCalledTimes(2);
    });
  });

  describe('when local tunnel invoke error/close events', () => {
    beforeEach(async () => {
      mockCache.hget = jest.fn().mockImplementation((key, field) => {
        if (key === 'trailing-trade-common' && field === 'local-tunnel-url') {
          return 'old-domain.loca.lt';
        }

        return '';
      });

      mockLocalTunnelOn = jest.fn().mockImplementation((_event, cb) => {
        cb();
      });

      jest.mock('localtunnel', () =>
        jest.fn().mockImplementation(() => ({
          url: 'my-domain.loca.lt',
          on: mockLocalTunnelOn
        }))
      );

      localTunnel = require('localtunnel');

      const { configureLocalTunnel } = require('../configure');

      await configureLocalTunnel(mockLogger);

      // 120
      jest.advanceTimersByTime(60 * 60 * 1000);
    });

    it('calls localTunnel two times', () => {
      expect(localTunnel).toHaveBeenCalledTimes(2);
    });
  });
});
