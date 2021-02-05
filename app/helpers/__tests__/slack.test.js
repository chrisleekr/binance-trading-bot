const config = require('config');
const axios = require('axios');
const slack = require('../slack');

jest.mock('config');
jest.mock('axios');

describe('slack', () => {
  let result;

  describe('sendMessage', () => {
    describe('when slack is not enabled', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'slack.enabled':
              return false;
            default:
              return '';
          }
        });

        result = await slack.sendMessage('my message');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when slack is enabled', () => {
      beforeEach(async () => {
        process.env.NODE_ENV = 'live';

        config.get = jest.fn(key => {
          switch (key) {
            case 'slack.enabled':
              return true;
            default:
              return `value-${key}`;
          }
        });

        axios.post = jest.fn().mockResolvedValue(true);

        result = await slack.sendMessage('my message');
      });

      it('triggers axios.post', () => {
        expect(axios.post).toHaveBeenCalledWith('value-slack.webhookUrl', {
          channel: 'value-slack.channel',
          text: 'my message',
          type: 'mrkdwn',
          username: 'value-slack.username - value-mode'
        });
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });
  });
});
