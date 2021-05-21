const index = require('../index');

describe('index.js', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      cache: expect.any(Object),
      logger: expect.any(Object),
      slack: expect.any(Object),
      binance: expect.any(Object),
      mongo: expect.any(Object),
      PubSub: expect.any(Object)
    });
  });
});
