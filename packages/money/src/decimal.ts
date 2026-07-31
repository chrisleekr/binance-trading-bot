import Decimal from 'decimal.js';

/**
 * Canonical re-export of decimal.js. Strategies and indicators import the
 * Decimal constructor from here so the dependency surface stays in one place;
 * downstream packages may then continue to ban direct `decimal.js` imports
 * without losing access to the type.
 */
export { Decimal };
export default Decimal;
