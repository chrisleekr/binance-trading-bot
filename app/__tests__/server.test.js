/* eslint-disable global-require */
describe('server', () => {
  let mockMongo;
  let mockMongoConnect;
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

    require('../server');
  });

  it('triggers mongo.connect', () => {
    expect(mockMongoConnect).toHaveBeenCalled();
  });

  it('triggers runBinance', () => {
    expect(mockRunBinance).toHaveBeenCalled();
  });
});
