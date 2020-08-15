const { logger } = require('../../helpers');
const macdStopChaser = require('../macdStopChaser');

describe('macdStopChaser', () => {
  let result;
  describe('execute', () => {
    beforeEach(async () => {
      result = await macdStopChaser.execute(logger);
    });

    it('returns expected result', () => {
      // This meant to be failed.
      expect(result).toEqual({});
    });
  });
});
