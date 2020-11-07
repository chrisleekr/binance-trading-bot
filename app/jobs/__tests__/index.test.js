const index = require('../index');

describe('index', () => {
  it('defines expected', () => {
    expect(index).toStrictEqual({
      executeAlive: expect.any(Function),
      executeBbands: expect.any(Function),
      executeMacdStopChaser: expect.any(Function)
    });
  });
});
