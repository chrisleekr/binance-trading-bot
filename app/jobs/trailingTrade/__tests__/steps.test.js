const steps = require('../steps');

describe('steps.js', () => {
  it('defines expected', () => {
    expect(steps).toStrictEqual({
      getNextSymbol: expect.any(Function),
      getGlobalConfiguration: expect.any(Function),
      getExchangeSymbols: expect.any(Function),
      getSymbolConfiguration: expect.any(Function),
      getSymbolInfo: expect.any(Function),
      getAccountInfo: expect.any(Function),
      getOpenOrders: expect.any(Function),
      getIndicators: expect.any(Function),
      handleOpenOrders: expect.any(Function),
      determineAction: expect.any(Function),
      placeBuyOrder: expect.any(Function),
      placeSellOrder: expect.any(Function),
      removeLastBuyPrice: expect.any(Function),
      saveDataToCache: expect.any(Function)
    });
  });
});
