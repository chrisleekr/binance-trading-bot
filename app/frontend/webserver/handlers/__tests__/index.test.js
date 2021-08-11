const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      handleAuth: expect.any(Function),
      handleGridTradeArchiveGetBySymbol: expect.any(Function),
      handleGridTradeArchiveGetByQuoteAsset: expect.any(Function),
      handleGridTradeArchiveDelete: expect.any(Function),
      handle404: expect.any(Function)
    });
  });
});
