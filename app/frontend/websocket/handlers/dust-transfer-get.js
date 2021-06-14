const {
  getAccountInfo,
  extendBalancesWithDustTransfer
} = require('../../../cronjob/trailingTradeHelper/common');

const handleDustTransferGet = async (logger, ws, payload) => {
  logger.info({ payload }, 'Start dust transfer get');

  // Get current account info
  const accountInfo = await getAccountInfo(logger);
  const accountInfoWithDustTransfer = await extendBalancesWithDustTransfer(
    logger,
    accountInfo
  );

  // Get current price of pairs
  const dustTransfer = accountInfoWithDustTransfer.balances.reduce(
    (rawAcc, s) => {
      const acc = rawAcc;
      if (s.canDustTransfer === true) {
        acc.push(s);
      }
      return acc;
    },
    []
  );

  ws.send(
    JSON.stringify({
      result: true,
      type: 'dust-transfer-get-result',
      dustTransfer
    })
  );
};

module.exports = { handleDustTransferGet };
