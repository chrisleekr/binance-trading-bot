const steps = require('../steps');

describe('steps.js', () => {
  it('defines expected', () => {
    expect(steps).toStrictEqual({
      getNextSymbol: expect.any(Function),
      getGlobalConfiguration: expect.any(Function),
      getSymbolConfiguration: expect.any(Function),
      getAccountInfo: expect.any(Function),
      getIndicators: expect.any(Function),
      getOpenOrders: expect.any(Function),
      saveDataToCache: expect.any(Function)
    });
  });
});
