/* eslint-disable global-require */
describe('cache', () => {
  let result;
  let mockSet;
  let mockSetEx;
  let mockGet;
  let mockMulti;
  let mockTTL;
  let mockExec;
  let mockDel;
  let mockHSet;
  let mockHGet;
  let mockHGetAll;
  let mockHDel;
  let cache;

  let mockLock;
  let mockUnlock;

  describe('set', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      jest.mock('config');

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
      jest.clearAllMocks().resetModules();

      mockGet = jest.fn(() => 'my-value');

      jest.mock('config');
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
      jest.clearAllMocks().resetModules();

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

      jest.mock('config');
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
      jest.clearAllMocks().resetModules();

      jest.mock('config');

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
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      jest.mock('config');

      mockHSet = jest.fn(() => true);

      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          hset: mockHSet
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

    beforeEach(async () => {
      result = await cache.hset('my-key', 'my-field', 'my-value');
    });

    it('triggers lock', () => {
      expect(mockLock).toHaveBeenCalledWith('redlock:my-key:my-field', 500);
    });

    it('triggers mockHSet', () => {
      expect(mockHSet).toHaveBeenCalledWith('my-key', 'my-field', 'my-value');
    });

    it('triggers unlock', () => {
      expect(mockUnlock).toHaveBeenCalled();
    });

    it('returns', () => {
      expect(result).toBeTruthy();
    });
  });

  describe('hget', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockHGet = jest.fn(() => 'my-value');
      jest.mock('config');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          hget: mockHGet
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

    it('triggers mockGet', () => {
      expect(mockHGet).toHaveBeenCalledWith('my-key', 'my-field');
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
      jest.clearAllMocks().resetModules();

      mockHGet = jest.fn(() => 'my-value');
      jest.mock('config');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          hget: mockHGet
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

      result = await cache.hgetWithoutLock('my-key', 'my-field');
    });

    it('does not trigger lock', () => {
      expect(mockLock).not.toHaveBeenCalled();
    });

    it('triggers mockGet', () => {
      expect(mockHGet).toHaveBeenCalledWith('my-key', 'my-field');
    });

    it('does not trigger unlock', () => {
      expect(mockUnlock).not.toHaveBeenCalled();
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });

  describe('hgetall', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockHGetAll = jest.fn(() => 'my-value');
      jest.mock('config');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          hgetall: mockHGetAll
        }))
      );

      cache = require('../cache');

      result = await cache.hgetall('my-key');
    });

    it('triggers getAll', () => {
      expect(mockHGetAll).toHaveBeenCalledWith('my-key');
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });

  describe('hdel', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();

      mockHDel = jest.fn(() => 'my-value');
      jest.mock('config');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          hdel: mockHDel
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

    it('triggers hdel', () => {
      expect(mockHDel).toHaveBeenCalledWith('my-key', 'my-field');
    });

    it('triggers unlock', () => {
      expect(mockUnlock).toHaveBeenCalled();
    });
  });
});
