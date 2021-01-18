const { execute: executeBbands } = require('./bbands');
const { execute: executeAlive } = require('./alive');
const { execute: executeMacdStopChaser } = require('./macdStopChaser');
const { execute: executeSimpleStopChaser } = require('./simpleStopChaser');

module.exports = {
  executeBbands,
  executeAlive,
  executeMacdStopChaser,
  executeSimpleStopChaser
};
