/* eslint-disable global-require */
describe('cache', () => {
  let result;
  let mockKeys;
  let mockSet;
  let mockSetEx;
  let mockGet;
  let mockMulti;
  let mockTTL;
  let mockExec;
  let mockDel;
  let mockScan;
  let cache;

  let mockLock;
  let mockUnlock;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    jest.mock('config');
  });

  describe('keys', () => {
    beforeEach(async () => {
      mockKeys = jest.fn(() => ['test1', 'test2']);
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          keys: mockKeys
        }))
      );

      cache = require('../cache');

      result = await cache.keys('*symbol-info');
    });

    it('triggers keys', () => {
      expect(mockKeys).toHaveBeenCalledWith('*symbol-info');
    });

    it('returns expected result', () => {
      expect(result).toStrictEqual(['test1', 'test2']);
    });
  });

  describe('set', () => {
    beforeEach(() => {
      mockSet = jest.fn(() => true);
      mockSetEx = jest.fn(() => true);
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          set: mockSet,
          setex: mockSetEx
        }))
      );

      mockUnlock = jest.fn(() => true);
      mockLock = jest.fn(() => ({
        unlock: mockUnlock
      }));
      jest.mock('redlock', () =>
        jest.fn().mockImplementation(() => ({
          lock: mockLock
        }))
      );

      cache = require('../cache');
    });

    describe('when ttl is undefined', () => {
      beforeEach(async () => {
        result = await cache.set('my-key', 'my-value');
      });

      it('triggers lock', () => {
        expect(mockLock).toHaveBeenCalledWith('redlock:my-key', 500);
      });

      it('does not trigger setex', () => {
        expect(mockSetEx).not.toHaveBeenCalled();
      });

      it('triggers set', () => {
        expect(mockSet).toHaveBeenCalledWith('my-key', 'my-value');
      });

      it('triggers unlock', () => {
        expect(mockUnlock).toHaveBeenCalled();
      });

      it('returns', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('when ttl is defined', () => {
      beforeEach(async () => {
        result = await cache.set('my-key', 'my-value', 3600);
      });

      it('triggers lock', () => {
        expect(mockLock).toHaveBeenCalledWith('redlock:my-key', 500);
      });

      it('triggers setex', () => {
        expect(mockSetEx).toHaveBeenCalledWith('my-key', 3600, 'my-value');
      });

      it('does not trigger set', () => {
        expect(mockSet).not.toHaveBeenCalled();
      });

      it('triggers unlock', () => {
        expect(mockUnlock).toHaveBeenCalled();
      });

      it('returns', () => {
        expect(result).toBeTruthy();
      });
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      mockGet = jest.fn(() => 'my-value');

      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          get: mockGet
        }))
      );

      mockUnlock = jest.fn(() => true);
      mockLock = jest.fn(() => ({
        unlock: mockUnlock
      }));
      jest.mock('redlock', () =>
        jest.fn().mockImplementation(() => ({
          lock: mockLock
        }))
      );

      cache = require('../cache');

      result = await cache.get('my-key');
    });

    it('triggers lock', () => {
      expect(mockLock).toHaveBeenCalledWith('redlock:my-key', 500);
    });

    it('triggers get', () => {
      expect(mockGet).toHaveBeenCalledWith('my-key');
    });

    it('triggers unlock', () => {
      expect(mockUnlock).toHaveBeenCalled();
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });

  describe('getWithTTL', () => {
    beforeEach(async () => {
      mockExec = jest.fn(() => 'test');

      mockGet = jest.fn(() => ({
        exec: mockExec
      }));

      mockTTL = jest.fn(() => ({
        get: mockGet
      }));

      mockMulti = jest.fn(() => ({
        ttl: mockTTL
      }));

      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          multi: mockMulti
        }))
      );

      cache = require('../cache');

      result = await cache.getWithTTL('my-key');
    });

    it('triggers ttl', () => {
      expect(mockTTL).toHaveBeenCalledWith('my-key');
    });

    it('triggers get', () => {
      expect(mockGet).toHaveBeenCalledWith('my-key');
    });

    it('returns expected value', () => {
      expect(result).toBe('test');
    });
  });

  describe('del', () => {
    beforeEach(async () => {
      mockDel = jest.fn(() => true);
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          del: mockDel
        }))
      );

      mockUnlock = jest.fn(() => true);
      mockLock = jest.fn(() => ({
        unlock: mockUnlock
      }));
      jest.mock('redlock', () =>
        jest.fn().mockImplementation(() => ({
          lock: mockLock
        }))
      );

      cache = require('../cache');

      result = await cache.del('my-key');
    });

    it('triggers lock', () => {
      expect(mockLock).toHaveBeenCalledWith('redlock:my-key', 500);
    });

    it('triggers del', () => {
      expect(mockDel).toHaveBeenCalledWith('my-key');
    });

    it('triggers unlock', () => {
      expect(mockUnlock).toHaveBeenCalled();
    });

    it('returns expected value', () => {
      expect(result).toBe(true);
    });
  });

  describe('hset', () => {
    describe('without ttl', () => {
      beforeEach(async () => {
        mockSet = jest.fn(() => true);

        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            set: mockSet
          }))
        );

        mockUnlock = jest.fn(() => true);
        mockLock = jest.fn(() => ({
          unlock: mockUnlock
        }));
        jest.mock('redlock', () =>
          jest.fn().mockImplementation(() => ({
            lock: mockLock
          }))
        );

        cache = require('../cache');
        result = await cache.hset('my-key', 'my-field', 'my-value');
      });

      it('triggers lock', () => {
        expect(mockLock).toHaveBeenCalledWith('redlock:my-key:my-field', 500);
      });

      it('triggers set', () => {
        expect(mockSet).toHaveBeenCalledWith('my-key:my-field', 'my-value');
      });

      it('triggers unlock', () => {
        expect(mockUnlock).toHaveBeenCalled();
      });

      it('returns true', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('with ttl', () => {
      beforeEach(async () => {
        mockSetEx = jest.fn(() => true);

        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            setex: mockSetEx
          }))
        );

        mockUnlock = jest.fn(() => true);
        mockLock = jest.fn(() => ({
          unlock: mockUnlock
        }));
        jest.mock('redlock', () =>
          jest.fn().mockImplementation(() => ({
            lock: mockLock
          }))
        );

        cache = require('../cache');
        result = await cache.hset('my-key', 'my-field', 'my-value', 3600);
      });

      it('triggers lock', () => {
        expect(mockLock).toHaveBeenCalledWith('redlock:my-key:my-field', 500);
      });

      it('triggers setex', () => {
        expect(mockSetEx).toHaveBeenCalledWith(
          'my-key:my-field',
          3600,
          'my-value'
        );
      });

      it('triggers unlock', () => {
        expect(mockUnlock).toHaveBeenCalled();
      });

      it('returns true', () => {
        expect(result).toBeTruthy();
      });
    });
  });

  describe('hget', () => {
    beforeEach(async () => {
      mockGet = jest.fn(() => 'my-value');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          get: mockGet
        }))
      );

      mockUnlock = jest.fn(() => true);
      mockLock = jest.fn(() => ({
        unlock: mockUnlock
      }));
      jest.mock('redlock', () =>
        jest.fn().mockImplementation(() => ({
          lock: mockLock
        }))
      );

      cache = require('../cache');

      result = await cache.hget('my-key', 'my-field');
    });

    it('triggers lock', () => {
      expect(mockLock).toHaveBeenCalledWith('redlock:my-key:my-field', 500);
    });

    it('triggers get', () => {
      expect(mockGet).toHaveBeenCalledWith('my-key:my-field');
    });

    it('triggers unlock', () => {
      expect(mockUnlock).toHaveBeenCalled();
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });

  describe('hgetWithoutLock', () => {
    beforeEach(async () => {
      mockGet = jest.fn(() => 'my-value');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          get: mockGet
        }))
      );

      cache = require('../cache');

      result = await cache.hgetWithoutLock('my-key', 'my-field');
    });

    it('triggers get', () => {
      expect(mockGet).toHaveBeenCalledWith('my-key:my-field');
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });

  describe('hgetall', () => {
    describe('with less than 1000', () => {
      beforeEach(async () => {
        mockScan = jest
          .fn()
          .mockResolvedValue(['0', ['prefix:key1', 'prefix:key2']]);
        mockGet = jest.fn().mockImplementation(key => `${key}-value`);
        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            scan: mockScan,
            get: mockGet
          }))
        );

        cache = require('../cache');

        result = await cache.hgetall('prefix:', 'prefix:key*');
      });

      it('triggers scan', () => {
        expect(mockScan).toHaveBeenCalledWith(
          '0',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );
      });

      it('triggers redis.get 2 times', () => {
        expect(mockGet).toHaveBeenCalledTimes(2);
      });

      it('triggers redis.get', () => {
        expect(mockGet).toHaveBeenCalledWith('prefix:key1');
        expect(mockGet).toHaveBeenCalledWith('prefix:key2');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          key1: 'prefix:key1-value',
          key2: 'prefix:key2-value'
        });
      });
    });

    describe('with more than 1000', () => {
      beforeEach(async () => {
        mockScan = jest
          .fn()
          .mockResolvedValueOnce(['1', ['prefix:key1', 'prefix:key2']])
          .mockResolvedValueOnce(['0', ['prefix:key3', 'prefix:key4']]);
        mockGet = jest.fn().mockImplementation(key => `${key}-value`);

        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            scan: mockScan,
            get: mockGet
          }))
        );

        cache = require('../cache');

        result = await cache.hgetall('prefix:', 'prefix:key*');
      });

      it('triggers redis.scan twice', () => {
        expect(mockScan).toHaveBeenCalledTimes(2);
      });

      it('triggers redis.scan', () => {
        expect(mockScan).toHaveBeenCalledWith(
          '0',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );

        expect(mockScan).toHaveBeenCalledWith(
          '1',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );
      });

      it('triggers redis.get 4 times', () => {
        expect(mockGet).toHaveBeenCalledTimes(4);
      });

      it('triggers redis.get', () => {
        expect(mockGet).toHaveBeenCalledWith('prefix:key1');
        expect(mockGet).toHaveBeenCalledWith('prefix:key2');
        expect(mockGet).toHaveBeenCalledWith('prefix:key3');
        expect(mockGet).toHaveBeenCalledWith('prefix:key4');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({
          key1: 'prefix:key1-value',
          key2: 'prefix:key2-value',
          key3: 'prefix:key3-value',
          key4: 'prefix:key4-value'
        });
      });
    });

    describe('for some reason, reply[1] undefined', () => {
      beforeEach(async () => {
        mockScan = jest.fn().mockResolvedValue(['0']);
        mockGet = jest.fn().mockImplementation(key => `${key}-value`);
        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            scan: mockScan,
            get: mockGet
          }))
        );

        cache = require('../cache');

        result = await cache.hgetall('prefix:', 'prefix:key*');
      });

      it('triggers scan', () => {
        expect(mockScan).toHaveBeenCalledWith(
          '0',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );
      });

      it('triggers redis.get 0 times', () => {
        expect(mockGet).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });
    });
  });

  describe('hdel', () => {
    beforeEach(async () => {
      mockDel = jest.fn(() => 'my-value');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          del: mockDel
        }))
      );

      mockUnlock = jest.fn(() => true);
      mockLock = jest.fn(() => ({
        unlock: mockUnlock
      }));
      jest.mock('redlock', () =>
        jest.fn().mockImplementation(() => ({
          lock: mockLock
        }))
      );

      cache = require('../cache');

      result = await cache.hdel('my-key', 'my-field');
    });

    it('triggers lock', () => {
      expect(mockLock).toHaveBeenCalledWith('redlock:my-key:my-field', 500);
    });

    it('triggers del', () => {
      expect(mockDel).toHaveBeenCalledWith('my-key:my-field');
    });

    it('triggers unlock', () => {
      expect(mockUnlock).toHaveBeenCalled();
    });
  });

  describe('hdelall', () => {
    beforeEach(() => {
      mockUnlock = jest.fn(() => true);
      mockLock = jest.fn(() => ({
        unlock: mockUnlock
      }));
      jest.mock('redlock', () =>
        jest.fn().mockImplementation(() => ({
          lock: mockLock
        }))
      );
    });

    describe('with less than 1000', () => {
      beforeEach(async () => {
        mockScan = jest
          .fn()
          .mockResolvedValue(['0', ['prefix:key1', 'prefix:key2']]);
        mockDel = jest.fn().mockResolvedValue(true);
        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            scan: mockScan,
            del: mockDel
          }))
        );

        cache = require('../cache');

        result = await cache.hdelall('prefix:key*');
      });

      it('triggers scan', () => {
        expect(mockScan).toHaveBeenCalledWith(
          '0',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );
      });

      it('triggers redis.del 2 times', () => {
        expect(mockDel).toHaveBeenCalledTimes(2);
      });

      it('triggers redis.del', () => {
        expect(mockDel).toHaveBeenCalledWith('prefix:key1');
        expect(mockDel).toHaveBeenCalledWith('prefix:key2');
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('with more than 1000', () => {
      beforeEach(async () => {
        mockScan = jest
          .fn()
          .mockResolvedValueOnce(['1', ['prefix:key1', 'prefix:key2']])
          .mockResolvedValueOnce(['0', ['prefix:key3', 'prefix:key4']]);
        mockDel = jest.fn().mockResolvedValue(true);

        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            scan: mockScan,
            del: mockDel
          }))
        );

        cache = require('../cache');

        result = await cache.hdelall('prefix:key*');
      });

      it('triggers redis.scan twice', () => {
        expect(mockScan).toHaveBeenCalledTimes(2);
      });

      it('triggers redis.scan', () => {
        expect(mockScan).toHaveBeenCalledWith(
          '0',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );

        expect(mockScan).toHaveBeenCalledWith(
          '1',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );
      });

      it('triggers redis.del 4 times', () => {
        expect(mockDel).toHaveBeenCalledTimes(4);
      });

      it('triggers redis.del', () => {
        expect(mockDel).toHaveBeenCalledWith('prefix:key1');
        expect(mockDel).toHaveBeenCalledWith('prefix:key2');
        expect(mockDel).toHaveBeenCalledWith('prefix:key3');
        expect(mockDel).toHaveBeenCalledWith('prefix:key4');
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('for some reason, reply[1] undefined', () => {
      beforeEach(async () => {
        mockScan = jest.fn().mockResolvedValue(['0']);
        mockDel = jest.fn().mockResolvedValue(true);
        jest.mock('ioredis', () =>
          jest.fn().mockImplementation(() => ({
            scan: mockScan,
            del: mockDel
          }))
        );

        cache = require('../cache');

        result = await cache.hdelall('prefix:key*');
      });

      it('triggers scan', () => {
        expect(mockScan).toHaveBeenCalledWith(
          '0',
          'MATCH',
          'prefix:key*',
          'COUNT',
          1000
        );
      });

      it('triggers redis.del 0 times', () => {
        expect(mockDel).not.toHaveBeenCalled();
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });
  });
});
