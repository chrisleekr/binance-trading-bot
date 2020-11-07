/* eslint-disable global-require */
describe('cache', () => {
  let result;
  let mockSet;
  let mockGet;
  let cache;

  describe('set', () => {
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockSet = jest.fn(() => true);
      jest.mock('config');
      jest.mock('ioredis', () => {
        return jest.fn().mockImplementation(() => ({
          set: mockSet
        }));
      });

      cache = require('../cache');
    });

    describe('when ttl is undefined', () => {
      beforeEach(() => {
        result = cache.set('my-key', 'my-value');
      });

      it('triggers mockSet', () => {
        expect(mockSet).toHaveBeenCalledWith('my-key', 'my-value');
      });

      it('returns', () => {
        expect(result).toBeTruthy();
      });
    });

    describe('when ttl is defined', () => {
      beforeEach(() => {
        result = cache.set('my-key', 'my-value', 3600);
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
    beforeEach(() => {
      jest.clearAllMocks().resetModules();

      mockGet = jest.fn(() => 'my-value');
      jest.mock('config');
      jest.mock('ioredis', () => {
        return jest.fn().mockImplementation(() => ({
          get: mockGet
        }));
      });

      cache = require('../cache');

      result = cache.get('my-key');
    });

    it('triggers mockGet', () => {
      expect(mockGet).toHaveBeenCalledWith('my-key');
    });

    it('returns expected value', () => {
      expect(result).toBe('my-value');
    });
  });
});
