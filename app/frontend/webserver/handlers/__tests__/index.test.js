/* eslint-disable global-require */
describe('index', () => {
  let index;

  let mockHandleAuth;
  let mockHandleGridTradeArchiveGet;
  let mockHandleGridTradeArchiveDelete;
  let mockHandleClosedTradesSetPeriod;
  let mockHandle404;
  beforeEach(async () => {
    jest.clearAllMocks().resetModules();

    mockHandleAuth = jest.fn().mockResolvedValue(true);
    mockHandleGridTradeArchiveGet = jest.fn().mockResolvedValue(true);
    mockHandleGridTradeArchiveDelete = jest.fn().mockResolvedValue(true);
    mockHandleClosedTradesSetPeriod = jest.fn().mockResolvedValue(true);
    mockHandle404 = jest.fn().mockResolvedValue(true);

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

    jest.mock('../404', () => ({
      handle404: mockHandle404
    }));

    index = require('../index');
    await index.setHandlers('logger', 'app');
  });

  it('triggers handleAuth', () => {
    expect(mockHandle404).toHaveBeenCalledWith('logger', 'app');
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

  it('triggers handle404', () => {
    expect(mockHandle404).toHaveBeenCalledWith('logger', 'app');
  });
});
