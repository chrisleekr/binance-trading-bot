const config = require('config');
const bcrypt = require('bcrypt');
const { PubSub, cache } = require('../../../helpers');

const handlePassword = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start password verify');
  ws.send(
    JSON.stringify({
      result: true,
      type: 'debug',
      content: payload
    })
  );

  const {
    data: { password, loginWindowMinutes }
  } = payload;
  const retrievedPassword = config.get('password'); // The valid password

  // If wrong password, send an error notification:
  if (retrievedPassword !== password) {
    return PubSub.publish('frontend-notification', {
      type: 'error',
      title: `Bad password.`
    });
  }
  ws.send(JSON.stringify({ conf: config }));
  // Update cache to auto-auth:
  await cache.set(
    `tempLogin`,
    JSON.stringify({ logged: true, elapsedTime: new Date() }),
    loginWindowMinutes * 60
  );

  PubSub.publish('frontend-notification', {
    type: 'success',
    title: `Unlocking bot.`
  });
  ws.send(JSON.stringify({ result: true, type: 'login-success' }));
};

module.exports = { handlePassword };
