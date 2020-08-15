const { execute: executeBbands } = require('./bbands');
const { execute: executeAlive } = require('./alive');
const { execute: executeMacdStopChaser } = require('./macdStopChaser');

module.exports = {
  executeBbands,
  executeAlive,
  executeMacdStopChaser
};
