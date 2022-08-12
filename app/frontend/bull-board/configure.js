const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const basePath = '/queue';

let callReplaceQueues;

const configureBullBoard = (app, funcLogger) => {
  const logger = funcLogger.child({ server: 'bull-board' });

  const serverAdapter = new ExpressAdapter();

  serverAdapter.setBasePath(basePath);

  const { replaceQueues } = createBullBoard({
    queues: [],
    serverAdapter
  });
  callReplaceQueues = replaceQueues;

  app.use(basePath, serverAdapter.getRouter());
  logger.info('Bull board is configured.');
};

const setBullBoardQueues = (queues, funcLogger) => {
  const logger = funcLogger.child({ server: 'bull-board' });

  const queuesForBoard = Object.values(queues).map(q => new BullAdapter(q));
  callReplaceQueues(queuesForBoard);

  logger.info('Bull board is updated.');
};

module.exports = { configureBullBoard, setBullBoardQueues };
