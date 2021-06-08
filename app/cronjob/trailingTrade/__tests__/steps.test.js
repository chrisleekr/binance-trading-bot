const steps = require('../steps');

describe('steps.js', () => {
  it('defines expected', () => {
    expect(steps).toStrictEqual({
      getSymbolConfiguration: expect.any(Function),
      getSymbolInfo: expect.any(Function),
      getBalances: expect.any(Function),
      getOverrideAction: expect.any(Function),
      ensureManualBuyOrder: expect.any(Function),
      ensureOrderPlaced: expect.any(Function),
      getOpenOrders: expect.any(Function),
      getIndicators: expect.any(Function),
      handleOpenOrders: expect.any(Function),
      determineAction: expect.any(Function),
      placeManualTrade: expect.any(Function),
      cancelOrder: expect.any(Function),
      placeBuyOrder: expect.any(Function),
      placeSellOrder: expect.any(Function),
      placeSellStopLossOrder: expect.any(Function),
      removeLastBuyPrice: expect.any(Function),
      saveDataToCache: expect.any(Function)
    });
  });
});
