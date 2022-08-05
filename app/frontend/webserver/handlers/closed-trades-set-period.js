const { cache } = require('../../../helpers');

const handleClosedTradesSetPeriod = async (funcLogger, app) => {
  const logger = funcLogger.child({
    endpoint: '/closed-trades-set-period'
  });
  app.route('/closed-trades-set-period').post(async (req, res) => {
    const { selectedPeriod, selectedPeriodTZ, selectedPeriodLC } = req.body;

    logger.info(
      { selectedPeriod, selectedPeriodTZ, selectedPeriodLC },
      'Set period for closed trades'
    );

    const closedTradesSetting =
      JSON.parse(await cache.hget('trailing-trade-common', 'closed-trades')) ||
      {};

    await cache.hset(
      'trailing-trade-common',
      'closed-trades',
      JSON.stringify({
        ...closedTradesSetting,
        selectedPeriod,
        selectedPeriodTZ,
        selectedPeriodLC
      })
    );

    // Reset closed trades history
    await cache.hdelall('trailing-trade-closed-trades:*');

    return res.send({
      success: true,
      status: 200,
      message: 'Set closed-trades-set-period',
      data: {}
    });
  });
};

module.exports = { handleClosedTradesSetPeriod };
