const config = require('config');
const axios = require('axios');
const messager = require('../messager');

jest.mock('config');
jest.mock('axios');

describe('messager', () => {
  let result;

  describe('sendMessage', () => {
    describe('when messager is not enabled', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'messager.enabled':
              return false;
            default:
              return '';
          }
        });

        result = await messager.sendMessage('my message');
      });

      it('returns expected value', () => {
        expect(result).toStrictEqual({});
      });
    });

    describe('when messager is enabled', () => {
      beforeEach(async () => {
        process.env.NODE_ENV = 'live';

        config.get = jest.fn(key => {
          switch (key) {
            case 'messager.enabled':
              return true;
            default:
              return `value-${key}`;
          }
        });

        axios.post = jest.fn().mockResolvedValue(true);

        result = await messager.sendMessage('my message');
      });

      it('triggers axios.post', () => {
        expect(axios.post).toHaveBeenCalledWith('value-messager.webhookUrl', {
          channel: 'value-messager.channel',
          text: 'my message',
          type: 'mrkdwn',
          username: 'value-messager.username - value-mode'
        });
      });

      it('returns expected value', () => {
        expect(result).toBeTruthy();
      });
    });
  });
});
