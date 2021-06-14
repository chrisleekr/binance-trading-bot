const steps = require('../steps');

describe('steps.js', () => {
  it('defines expected', () => {
    expect(steps).toStrictEqual({
      getGlobalConfiguration: expect.any(Function),
      getSymbolConfiguration: expect.any(Function),
      getNextSymbol: expect.any(Function),
      getOverrideAction: expect.any(Function),
      getAccountInfo: expect.any(Function),
      getIndicators: expect.any(Function),
      getOpenOrders: expect.any(Function),
      executeDustTransfer: expect.any(Function),
      saveDataToCache: expect.any(Function)
    });
  });
});
