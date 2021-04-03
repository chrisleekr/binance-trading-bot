/**
 * Calculate round down
 *
 * @param {*} number
 * @param {*} decimals
 */
const roundDown = (number, decimals) =>
  // eslint-disable-next-line no-restricted-properties
  Math.floor(number * Math.pow(10, decimals)) / Math.pow(10, decimals);

module.exports = {
  roundDown
};
