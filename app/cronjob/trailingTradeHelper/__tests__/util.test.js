const util = require('../util');

describe('util.js', () => {
  let result;
  describe('roundDown', () => {
    [
      {
        number: 123.02039,
        decimal: 2,
        expected: 123.02
      },
      {
        number: 123.02639,
        decimal: 2,
        expected: 123.02
      },
      {
        number: 123.02539,
        decimal: 2,
        expected: 123.02
      }
    ].forEach(t => {
      describe(`test ${t.number} - ${t.decimal}`, () => {
        beforeEach(() => {
          result = util.roundDown(t.number, t.decimal);
        });

        it('returns expected value', () => {
          expect(result).toStrictEqual(t.expected);
        });
      });
    });
  });
});
