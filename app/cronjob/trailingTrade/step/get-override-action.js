const _ = require('lodash');
const moment = require('moment');

const {
  getOverrideDataForSymbol,
  removeOverrideDataForSymbol,
  isActionDisabled,
  saveOverrideAction
} = require('../../trailingTradeHelper/common');

/**
 * Validate whether the auto trigger buy action needs to be rescheduled.
 *
 * @param {*} logger
 * @param {*} data
 * @returns
 */
const shouldRescheduleBuyAction = async (logger, data) => {
  const {
    symbol,
    symbolConfiguration: {
      buy: {
        athRestriction: { enabled: buyATHRestrictionEnabled }
      },
      botOptions: {
        autoTriggerBuy: {
          conditions: { whenLessThanATHRestriction, afterDisabledPeriod }
        }
      }
    },
    buy: { currentPrice, athRestrictionPrice }
  } = data;

  // If the current price is higher than the restriction price, reschedule it
  if (
    buyATHRestrictionEnabled &&
    whenLessThanATHRestriction &&
    currentPrice > athRestrictionPrice
  ) {
    const rescheduleReason =
      `The auto-trigger buy action needs to be re-scheduled ` +
      `because the current price is higher than ATH restriction price.`;
    logger.info(
      {
        buyATHRestrictionEnabled,
        whenLessThanATHRestriction,
        currentPrice,
        athRestrictionPrice
      },
      rescheduleReason
    );
    return { shouldReschedule: true, rescheduleReason };
  }

  const checkDisable = await isActionDisabled(symbol);

  // If the symbol is disabled for some reason,
  if (afterDisabledPeriod && checkDisable.isDisabled) {
    const rescheduleReason =
      `The auto-trigger buy action needs to be re-scheduled ` +
      `because the action is disabled at the moment.`;
    logger.info(
      {
        afterDisabledPeriod,
        checkDisable
      },
      rescheduleReason
    );

    return { shouldReschedule: true, rescheduleReason };
  }

  return { shouldReschedule: false, rescheduleReason: null };
};

/**
 * Override action
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;

  const {
    action,
    symbol,
    isLocked,
    symbolConfiguration: {
      botOptions: {
        autoTriggerBuy: { triggerAfter: autoTriggerBuyTriggerAfter }
      }
    }
  } = data;

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

  data.overrideData = overrideData || {};
  // Override action
  if (
    (_.get(overrideData, 'action') === 'buy' ||
      _.get(overrideData, 'action') === 'sell' ||
      _.get(overrideData, 'action') === 'manual-trade' ||
      _.get(overrideData, 'action') === 'cancel-order') &&
    moment(_.get(overrideData, 'actionAt', undefined)) <= moment()
  ) {
    // If the buy action is triggered by auto trigger
    if (
      overrideData.action === 'buy' &&
      overrideData.triggeredBy === 'auto-trigger'
    ) {
      // Check whether it needs to be rescheduled.
      const { shouldReschedule, rescheduleReason } =
        await shouldRescheduleBuyAction(logger, data);

      // If it needs to be rescheduled
      if (shouldReschedule) {
        // Reschedule buy action
        await saveOverrideAction(
          logger,
          symbol,
          {
            ...overrideData,
            actionAt: moment()
              .add(autoTriggerBuyTriggerAfter, 'minutes')
              .format()
          },
          rescheduleReason
        );
        return data;
      }
    }

    // Otherwise, override current action
    data.action = overrideData.action;
    data.order = overrideData.order || {};

    // Remove override data to avoid multiple execution
    await removeOverrideDataForSymbol(logger, symbol);
  }

  return data;
};

module.exports = { execute };
