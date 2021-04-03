const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      executeAlive: expect.any(Function),
      executeTrailingTrade: expect.any(Function),
      executeTrailingTradeIndicator: expect.any(Function)
    });
  });
});
