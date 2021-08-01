const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      handleAuth: expect.any(Function),
      handle404: expect.any(Function)
    });
  });
});
