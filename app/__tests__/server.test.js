/* eslint-disable global-require */
describe('server', () => {
  let mockRunCronJob;
  let mockRunWebSocket;
  let mockRunFrontend;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    mockRunCronJob = jest.fn().mockResolvedValue(true);
    mockRunWebSocket = jest.fn().mockResolvedValue(true);
    mockRunFrontend = jest.fn().mockResolvedValue(true);

    jest.mock('../server-cronjob', () => ({ runCronjob: mockRunCronJob }));
    jest.mock('../server-websocket', () => ({
      runWebSocket: mockRunWebSocket
    }));
    jest.mock('../server-frontend', () => ({ runFrontend: mockRunFrontend }));

    require('../server');
  });

  it('tirggers runCronjob', () => {
    expect(mockRunCronJob).toHaveBeenCalled();
  });
});
