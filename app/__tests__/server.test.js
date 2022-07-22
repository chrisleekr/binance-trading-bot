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
      mongo: mockMongo,
      errorHandler: {
        run: mockRunErrorHandler
      }
    }));

    jest.mock('../server-binance', () => ({ runBinance: mockRunBinance }));
    jest.mock('../server-cronjob', () => ({ runCronjob: mockRunCronJob }));
    jest.mock('../server-frontend', () => ({ runFrontend: mockRunFrontend }));

    require('../server');
  });

  it('triggers errorHandler.run', () => {
    expect(mockRunErrorHandler).toHaveBeenCalled();
  });

  it('triggers mongo.connect', () => {
    expect(mockMongoConnect).toHaveBeenCalled();
  });

  it('triggers runBinance', () => {
    expect(mockRunBinance).toHaveBeenCalled();
  });
});
