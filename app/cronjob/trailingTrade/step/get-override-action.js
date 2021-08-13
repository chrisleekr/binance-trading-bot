const _ = require('lodash');
const moment = require('moment');

const {
  getOverrideDataForSymbol,
  removeOverrideDataForSymbol
} = require('../../trailingTradeHelper/common');

/**
 * Override action
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { action, symbol, isLocked } = data;

  if (isLocked) {
    logger.info(
      { isLocked },
      'Symbol is locked, do not process override-action'
    );
    return data;
  }

  if (action !== 'not-determined') {
    logger.info(
      { action },
      'Action is already defined, do not try to override action.'
    );
    return data;
  }

  const overrideData = await getOverrideDataForSymbol(logger, symbol);

  // Override action
  if (
    (_.get(overrideData, 'action') === 'buy' ||
      _.get(overrideData, 'action') === 'sell' ||
      _.get(overrideData, 'action') === 'manual-trade' ||
      _.get(overrideData, 'action') === 'cancel-order') &&
    moment(_.get(overrideData, 'actionAt', undefined)) <= moment()
  ) {
    data.action = overrideData.action;
    data.order = overrideData.order || {};
    // Remove override data to avoid multiple execution
    await removeOverrideDataForSymbol(logger, symbol);
    return data;
  }

  return data;
};

module.exports = { execute };
