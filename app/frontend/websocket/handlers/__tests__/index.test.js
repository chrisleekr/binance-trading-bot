const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      handleLatest: expect.any(Function),
      handleSettingUpdate: expect.any(Function),
      handleSymbolUpdate: expect.any(Function),
      handleSymbolDelete: expect.any(Function),
      handleSymbolSettingUpdate: expect.any(Function),
      handleSymbolSettingDelete: expect.any(Function),
      handleSymbolEnableAction: expect.any(Function)
    });
  });
});
