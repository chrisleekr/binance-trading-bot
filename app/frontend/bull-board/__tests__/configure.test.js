/* eslint-disable global-require */
describe('bull-board/configure.js', () => {
  let mockLogger;

  let mockExpressUse;

  let mockReplaceQueues;
  let mockCreateBullBoard;
  let mockBullAdapter;

  let mockExpressAdapter;
  let mockExpressAdapterSetBasePath;
  let mockExpressAdapterGetRouter;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();

    const { logger } = require('../../../helpers');
    mockLogger = logger;

    mockReplaceQueues = jest.fn();
    mockCreateBullBoard = jest.fn(() => ({
      replaceQueues: mockReplaceQueues
    }));
    jest.mock('@bull-board/api', () => ({
      createBullBoard: mockCreateBullBoard
    }));

    mockExpressAdapterSetBasePath = jest.fn();
    mockExpressAdapterGetRouter = jest.fn(() => ({ router: 'here' }));
    mockExpressAdapter = jest.fn().mockImplementation(() => ({
      setBasePath: mockExpressAdapterSetBasePath,
      getRouter: mockExpressAdapterGetRouter
    }));

    jest.mock('@bull-board/express', () => ({
      ExpressAdapter: mockExpressAdapter
    }));

    mockBullAdapter = jest
      .fn()
      .mockImplementation(() => ({ queue: 'instance' }));
    jest.mock('@bull-board/api/bullAdapter', () => ({
      BullAdapter: mockBullAdapter
    }));

    mockExpressUse = jest.fn();
  });

  describe('configureBullBoard', () => {
    beforeEach(() => {
      const { configureBullBoard } = require('../configure');
      configureBullBoard(
        {
          use: mockExpressUse
        },
        mockLogger
      );
    });

    it('triggers ExpressAdapter.setBasePath', () => {
      expect(mockExpressAdapterSetBasePath).toHaveBeenCalledWith('/queue');
    });

    it('triggers createBullBoard', () => {
      expect(mockCreateBullBoard).toHaveBeenCalledWith({
        queues: [],
        serverAdapter: expect.any(Object)
      });
    });

    it('triggers ExpressAdapter.getRouter', () => {
      expect(mockExpressAdapterGetRouter).toHaveBeenCalled();
    });

    it('triggers app.use', () => {
      expect(mockExpressUse).toHaveBeenCalledWith('/queue', { router: 'here' });
    });
  });

  describe('setBullBoardQueues', () => {
    beforeEach(() => {
      const {
        configureBullBoard,
        setBullBoardQueues
      } = require('../configure');

      configureBullBoard(
        {
          use: mockExpressUse
        },
        mockLogger
      );
      setBullBoardQueues({ BTCUSDT: 'queue1', ETHUSDT: 'queue2' }, mockLogger);
    });

    it('triggers BullAdapter 2 times', () => {
      expect(mockBullAdapter).toHaveBeenCalledTimes(2);
    });

    it('triggers callReplaceQueues', () => {
      expect(mockReplaceQueues).toHaveBeenCalled();
    });
  });
});
