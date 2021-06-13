const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      handleLatest: expect.any(Function),
      handleSettingUpdate: expect.any(Function),
      handleSymbolUpdateLastBuyPrice: expect.any(Function),
      handleSymbolDelete: expect.any(Function),
      handleSymbolSettingUpdate: expect.any(Function),
      handleSymbolSettingDelete: expect.any(Function),
      handleSymbolEnableAction: expect.any(Function),
      handleManualTradeAllSymbols: expect.any(Function),
      handleManualTrade: expect.any(Function),
      handleCancelOrder: expect.any(Function),
      handleDustTransferGet: expect.any(Function),
      handleDustTransferExecute: expect.any(Function)
    });
  });
});
