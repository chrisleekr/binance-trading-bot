/* eslint-disable global-require */
describe('server', () => {
  let mockMongo;
  let mockMongoConnect;
  let mockRunErrorHandler;
  let mockRunBinance;
  let mockRunCronJob;
  let mockRunFrontend;

  let mockLoggerChild;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    mockMongoConnect = jest.fn().mockResolvedValue(true);
    mockMongo = {
      connect: mockMongoConnect
    };

    mockRunErrorHandler = jest.fn().mockResolvedValue(true);
    mockRunBinance = jest.fn().mockResolvedValue(true);
    mockRunCronJob = jest.fn().mockResolvedValue(true);
    mockRunFrontend = jest.fn().mockResolvedValue(true);

    mockLoggerChild = jest.fn().mockResolvedValue({ child: 'logger' });
    jest.mock('../helpers', () => ({
      logger: { me: 'logger', child: mockLoggerChild },
      mongo: mockMongo
    }));

    jest.mock('../server-binance', () => ({ runBinance: mockRunBinance }));
    jest.mock('../server-cronjob', () => ({ runCronjob: mockRunCronJob }));
    jest.mock('../server-frontend', () => ({ runFrontend: mockRunFrontend }));
    jest.mock('../error-handler', () => ({
      runErrorHandler: mockRunErrorHandler
    }));

    require('../server');
  });

  it('triggers runErrorHandler', () => {
    expect(mockRunErrorHandler).toHaveBeenCalled();
  });

  it('triggers mongo.connect', () => {
    expect(mockMongoConnect).toHaveBeenCalled();
  });

  it('triggers runBinance', () => {
    expect(mockRunBinance).toHaveBeenCalled();
  });

  it('triggers runCronjob', () => {
    expect(mockRunCronJob).toHaveBeenCalled();
  });

  it('triggers runFrontend', () => {
    expect(mockRunFrontend).toHaveBeenCalled();
  });
});
