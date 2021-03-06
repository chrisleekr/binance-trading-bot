/* eslint-disable global-require */
describe('cache', () => {
  let result;
  let mockSet;
  let mockGet;
  let mockHSet;
  let mockHGet;
  let mockHGetAll;
  let mockHDel;
  let cache;

  describe('set', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockSet = jest.fn(() => true);
      jest.mock('config');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          set: mockSet
        }))
      );

      cache = require('../cache');
    });

    describe('when ttl is undefined', () => {
      beforeEach(async () => {
        result = await cache.set('my-key', 'my-value');
      });

      it('triggers mockSet', () => {
        expect(mockSet).toHaveBeenCalledWith('my-key', 'my-value');
      });

      it('returns', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('when ttl is defined', () => {
      beforeEach(async () => {
        result = await cache.set('my-key', 'my-value', 3600);
      });

      it('triggers mockSet', () => {
        expect(mockSet).toHaveBeenCalledWith('my-key', 'my-value', 'EX', 3600);
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

      cache = require('../cache');

      result = await cache.get('my-key');
    });

    it('triggers mockGet', () => {
      expect(mockGet).toHaveBeenCalledWith('my-key');
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });

  describe('hset', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockHSet = jest.fn(() => true);
      jest.mock('config');
      jest.mock('ioredis', () =>
        jest.fn().mockImplementation(() => ({
          hset: mockHSet
        }))
      );

      cache = require('../cache');
    });

    beforeEach(async () => {
      result = await cache.hset('my-key', 'my-field', 'my-value');
    });

    it('triggers mockHSet', () => {
      expect(mockHSet).toHaveBeenCalledWith('my-key', 'my-field', 'my-value');
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

      cache = require('../cache');

      result = await cache.hget('my-key', 'my-field');
    });

    it('triggers mockGet', () => {
      expect(mockHGet).toHaveBeenCalledWith('my-key', 'my-field');
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

    it('triggers mockGet', () => {
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

      cache = require('../cache');

      result = await cache.hdel('my-key', 'my-field');
    });

    it('triggers mockGet', () => {
      expect(mockHDel).toHaveBeenCalledWith('my-key', 'my-field');
    });
  });
});
