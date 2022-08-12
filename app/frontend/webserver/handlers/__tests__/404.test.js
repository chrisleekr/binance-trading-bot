/* eslint-disable global-require */
describe('webserver/handlers/404', () => {
  const appMock = {};

  let resSendMock;
  let resStatusMock;

  beforeEach(async () => {
    resSendMock = jest.fn().mockReturnValue(true);
    resStatusMock = jest.fn().mockReturnValue({ send: resSendMock });
    appMock.get = jest.fn().mockImplementation((_path, func) => {
      func(null, { status: resStatusMock });
    });

    const { handle404 } = require('../404');

    await handle404(null, appMock);
  });

  it('triggers status', () => {
    expect(resStatusMock).toHaveBeenCalledWith(404);
  });

  it('triggers res.send', () => {
    expect(resSendMock).toHaveBeenCalledWith({
      success: false,
      status: 404,
      message: 'Route not found.',
      data: {}
    });
  });
});
