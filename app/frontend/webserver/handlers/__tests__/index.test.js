/* eslint-disable global-require */
describe('index', () => {
  let index;

  let mockHandleAuth;
  let mockHandleGridTradeArchiveGet;
  let mockHandleGridTradeArchiveDelete;
  let mockHandleClosedTradesSetPeriod;
  let mockHandle404;
  let mockHandleStatus;
  let mockHandleGridTradeLogsGet;
  let mockHandleGridTradeLogsExport;

  let mockLoginLimiter;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    mockHandleAuth = jest.fn().mockResolvedValue(true);
    mockHandleGridTradeArchiveGet = jest.fn().mockResolvedValue(true);
    mockHandleGridTradeArchiveDelete = jest.fn().mockResolvedValue(true);
    mockHandleClosedTradesSetPeriod = jest.fn().mockResolvedValue(true);
    mockHandle404 = jest.fn().mockResolvedValue(true);
    mockHandleStatus = jest.fn().mockResolvedValue(true);
    mockHandleGridTradeLogsGet = jest.fn().mockResolvedValue(true);
    mockHandleGridTradeLogsExport = jest.fn().mockResolvedValue(true);

    mockLoginLimiter = jest.fn().mockReturnValue(true);

    jest.mock('../auth', () => ({
      handleAuth: mockHandleAuth
    }));

    jest.mock('../grid-trade-archive-get', () => ({
      handleGridTradeArchiveGet: mockHandleGridTradeArchiveGet
    }));

    jest.mock('../grid-trade-archive-delete', () => ({
      handleGridTradeArchiveDelete: mockHandleGridTradeArchiveDelete
    }));

    jest.mock('../closed-trades-set-period', () => ({
      handleClosedTradesSetPeriod: mockHandleClosedTradesSetPeriod
    }));

    jest.mock('../grid-trade-logs-get', () => ({
      handleGridTradeLogsGet: mockHandleGridTradeLogsGet
    }));

    jest.mock('../grid-trade-logs-export', () => ({
      handleGridTradeLogsExport: mockHandleGridTradeLogsExport
    }));

    jest.mock('../404', () => ({
      handle404: mockHandle404
    }));

    jest.mock('../status', () => ({
      handleStatus: mockHandleStatus
    }));

    index = require('../index');
    await index.setHandlers('logger', 'app', {
      loginLimiter: mockLoginLimiter
    });
  });

  it('triggers handleAuth', () => {
    expect(mockHandleAuth).toHaveBeenCalledWith('logger', 'app', {
      loginLimiter: mockLoginLimiter
    });
  });

  it('triggers handleGridTradeArchiveGet', () => {
    expect(mockHandleGridTradeArchiveGet).toHaveBeenCalledWith('logger', 'app');
  });

  it('triggers handleGridTradeArchiveDelete', () => {
    expect(mockHandleGridTradeArchiveDelete).toHaveBeenCalledWith(
      'logger',
      'app'
    );
  });

  it('triggers handleClosedTradesSetPeriod', () => {
    expect(mockHandleClosedTradesSetPeriod).toHaveBeenCalledWith(
      'logger',
      'app'
    );
  });

  it('triggers handleGridTradeLogsGet', () => {
    expect(mockHandleGridTradeLogsGet).toHaveBeenCalledWith('logger', 'app');
  });

  it('triggers handleGridTradeLogsExport', () => {
    expect(mockHandleGridTradeLogsExport).toHaveBeenCalledWith('logger', 'app');
  });

  it('triggers handleStatus', () => {
    expect(mockHandleStatus).toHaveBeenCalledWith('logger', 'app');
  });

  it('triggers handle404', () => {
    expect(mockHandle404).toHaveBeenCalledWith('logger', 'app');
  });
});
