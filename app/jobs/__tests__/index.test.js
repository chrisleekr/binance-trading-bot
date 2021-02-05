const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      executeAlive: expect.any(Function),
      executeSimpleStopChaser: expect.any(Function)
    });
  });
});
