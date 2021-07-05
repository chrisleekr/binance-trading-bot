const _ = require('lodash');
const moment = require('moment');

const {
  getOverrideDataForIndicator,
  removeOverrideDataForIndicator
} = require('../../trailingTradeHelper/common');

/**
 * Override action
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const { action } = data;

  if (action !== 'not-determined') {
    logger.info(
      { action },
      'Action is already defined, do not try to override action.'
    );
    return data;
  }

  const overrideData = await getOverrideDataForIndicator(logger, 'global');

  // Override action
  if (
    _.get(overrideData, 'action') === 'dust-transfer' &&
    moment(_.get(overrideData, 'actionAt', undefined)) <= moment()
  ) {
    data.action = overrideData.action;
    data.overrideParams = overrideData.params;
    // Remove override data to avoid multiple execution
    await removeOverrideDataForIndicator(logger, 'global');
    return data;
  }

  return data;
};

module.exports = { execute };
