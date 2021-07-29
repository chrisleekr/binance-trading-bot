const { cache } = require('../../../helpers');

const handleDisconnect = async (logger, ws) => {
  logger.info({}, 'Disconnect');

  await cache.set(
    `tempLogin`,
    JSON.stringify({ logged: false, elapsedTime: new Date() }),
    0
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'disconnect'
    })
  );
};

module.exports = { handleDisconnect };
