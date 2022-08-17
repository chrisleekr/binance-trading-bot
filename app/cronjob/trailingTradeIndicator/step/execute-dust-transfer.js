const { binance, slack, PubSub } = require('../../../helpers');
const { getAPILimit } = require('../../trailingTradeHelper/common');

/**
 * Execute dust transfer
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { action, overrideParams } = rawData;

  if (action !== 'dust-transfer') {
    logger.info(
      `Do not process dust transfer because action is not 'dust-transfer'.`
    );
    return data;
  }

  const assets = overrideParams.reduce((acc, s) => {
    if (s.checked === true) {
      acc.push(s.asset);
    }

    return acc;
  }, []);

  slack.sendMessage(
    `Dust Transfer Action:\n` +
      `- Assets: \`\`\`${JSON.stringify(assets, undefined, 2)}\`\`\``,
    { apiLimit: getAPILimit(logger) }
  );

  try {
    const dustTransferResult = await binance.client.dustTransfer({
      asset: assets
    });

    PubSub.publish('frontend-notification', {
      type: 'success',
      title: `The dust transfer has been executed successfully. The account information will be updated soon.`
    });

    slack.sendMessage(
      `Dust Transfer Result:\n` +
        `- Result: \`\`\`${JSON.stringify(
          dustTransferResult,
          undefined,
          2
        )}\`\`\``,
      { apiLimit: getAPILimit(logger) }
    );
  } catch (e) {
    logger.error(e, 'Execution failed.');
    PubSub.publish('frontend-notification', {
      type: 'error',
      title: `The dust transfer is failed to execute. Try again later.`
    });

    slack.sendMessage(`Dust Transfer Error:\n- Message: ${e.message}`, {
      apiLimit: getAPILimit(logger)
    });
  }

  return data;
};

module.exports = { execute };
