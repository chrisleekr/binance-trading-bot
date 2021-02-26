/* eslint-disable global-require */
describe('server', () => {
  let mockMongo;
  let mockMongoConnect;
  let mockRunCronJob;
  let mockRunFrontend;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    mockMongoConnect = jest.fn().mockResolvedValue(true);
    mockMongo = {
      connect: mockMongoConnect
    };

    mockRunCronJob = jest.fn().mockResolvedValue(true);
    mockRunFrontend = jest.fn().mockResolvedValue(true);

    jest.mock('../helpers', () => ({
      logger: { me: 'logger' },
      mongo: mockMongo
    }));

    jest.mock('../server-cronjob', () => ({ runCronjob: mockRunCronJob }));
    jest.mock('../server-frontend', () => ({ runFrontend: mockRunFrontend }));

    require('../server');
  });

  it('triggers mongo.connect', () => {
    expect(mockMongoConnect).toHaveBeenCalled();
  });

  it('triggers runCronjob', () => {
    expect(mockRunCronJob).toHaveBeenCalled();
  });
});
