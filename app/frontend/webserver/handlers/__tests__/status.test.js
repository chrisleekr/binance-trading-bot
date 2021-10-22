/* eslint-disable global-require */
describe('webserver/handlers/status', () => {
  const appMock = {};

  let resSendMock;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    resSendMock = jest.fn().mockResolvedValue(true);
    appMock.get = jest.fn().mockImplementation((_path, func) => {
      func(null, { send: resSendMock });
    });
    const loggerMock = require('../../../../helpers/logger');

    const { handleStatus } = require('../status');

    await handleStatus(loggerMock, appMock);
  });

  it('triggers res.send', () => {
    expect(resSendMock).toHaveBeenCalledWith({
      success: true,
      status: 200,
      message: 'OK',
      data: {}
    });
  });
});
