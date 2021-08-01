/* eslint-disable global-require */
describe('webserver/handlers/404', () => {
  const appMock = {};

  let resSendMock;

  beforeEach(async () => {
    resSendMock = jest.fn().mockResolvedValue(true);
    appMock.get = jest.fn().mockImplementation((_path, func) => {
      func(null, { send: resSendMock });
    });

    const { handle404 } = require('../404');

    await handle404(null, appMock);
  });

  it('triggers res.send', () => {
    expect(resSendMock).toHaveBeenCalledWith(
      { success: false, status: 404, message: 'Route not found.', data: {} },
      404
    );
  });
});
