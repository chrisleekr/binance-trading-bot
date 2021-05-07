/* eslint-disable global-require */
const { logger, cache } = require('../helpers');

describe('server-cronjob', () => {
  let config;

  let mockCronJob;
  let mockTaskRunning = false;

  let mockExecuteAlive;
  let mockExecuteTrailingTrade;
  let mockExecuteTrailingTradeIndicator;

  describe('cronjob running fine', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();
      jest.mock('config');

      cache.hset = jest.fn().mockResolvedValue(true);

      mockExecuteAlive = jest.fn().mockResolvedValue(true);
      mockExecuteTrailingTrade = jest.fn().mockResolvedValue(true);
      mockExecuteTrailingTradeIndicator = jest.fn().mockResolvedValue(true);

      jest.mock('../cronjob', () => ({
        executeAlive: mockExecuteAlive,
        executeTrailingTrade: mockExecuteTrailingTrade,
        executeTrailingTradeIndicator: mockExecuteTrailingTradeIndicator
      }));

      mockCronJob = jest
        .fn()
        .mockImplementation(
          (_cronTime, onTick, _onComplete, _start, _timeZone) => ({
            taskRunning: mockTaskRunning,
            start: jest.fn(() => onTick())
          })
        );

      jest.mock('cron', () => ({
        CronJob: mockCronJob
      }));
      config = require('config');
    });

    describe('alive', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'jobs.alive.enabled':
              return true;
            case 'jobs.alive.cronTime':
              return '* * * * * *';
            case 'tz':
              return 'Australia/Melbourne';
            default:
              return `value-${key}`;
          }
        });
      });

      describe('when task is already running', () => {
        beforeEach(() => {
          mockTaskRunning = true;
          const { runCronjob } = require('../server-cronjob');
          runCronjob(logger);
        });

        it('initialise CronJob', () => {
          expect(mockCronJob).toHaveBeenCalledWith(
            '* * * * * *',
            expect.any(Function),
            null,
            false,
            'Australia/Melbourne'
          );
        });

        it('does not trigger executeAlive', () => {
          expect(mockExecuteAlive).not.toHaveBeenCalled();
        });
      });

      describe('when task is not running', () => {
        beforeEach(() => {
          mockTaskRunning = false;
          const { runCronjob } = require('../server-cronjob');
          runCronjob(logger);
        });

        it('initialise CronJob', () => {
          expect(mockCronJob).toHaveBeenCalledWith(
            '* * * * * *',
            expect.any(Function),
            null,
            false,
            'Australia/Melbourne'
          );
        });

        it('triggers executeAlive', () => {
          expect(mockExecuteAlive).toHaveBeenCalled();
        });
      });
    });

    describe('trailingTrade', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'jobs.trailingTrade.enabled':
              return true;
            case 'jobs.trailingTrade.cronTime':
              return '* * * * * *';
            case 'tz':
              return 'Australia/Melbourne';
            default:
              return `value-${key}`;
          }
        });
      });

      describe('when task is already running', () => {
        beforeEach(() => {
          mockTaskRunning = true;
          const { runCronjob } = require('../server-cronjob');
          runCronjob(logger);
        });

        it('initialise CronJob', () => {
          expect(mockCronJob).toHaveBeenCalledWith(
            '* * * * * *',
            expect.any(Function),
            null,
            false,
            'Australia/Melbourne'
          );
        });

        it('does not trigger executeTrailingTrade', () => {
          expect(mockExecuteTrailingTrade).not.toHaveBeenCalled();
        });
      });

      describe('when task is not running', () => {
        beforeEach(() => {
          mockTaskRunning = false;
          const { runCronjob } = require('../server-cronjob');
          runCronjob(logger);
        });

        it('initialise CronJob', () => {
          expect(mockCronJob).toHaveBeenCalledWith(
            '* * * * * *',
            expect.any(Function),
            null,
            false,
            'Australia/Melbourne'
          );
        });

        it('triggers executeTrailingTrade', () => {
          expect(mockExecuteTrailingTrade).toHaveBeenCalled();
        });
      });
    });

    describe('trailingTradeIndicator', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            case 'jobs.trailingTradeIndicator.enabled':
              return true;
            case 'jobs.trailingTradeIndicator.cronTime':
              return '* * * * * *';
            case 'tz':
              return 'Australia/Melbourne';
            default:
              return `value-${key}`;
          }
        });
      });

      describe('when task is already running', () => {
        beforeEach(() => {
          mockTaskRunning = true;
          const { runCronjob } = require('../server-cronjob');
          runCronjob(logger);
        });

        it('initialise CronJob', () => {
          expect(mockCronJob).toHaveBeenCalledWith(
            '* * * * * *',
            expect.any(Function),
            null,
            false,
            'Australia/Melbourne'
          );
        });

        it('does not trigger executeTrailingTradeIndicator', () => {
          expect(mockExecuteTrailingTradeIndicator).not.toHaveBeenCalled();
        });
      });

      describe('when task is not running', () => {
        beforeEach(() => {
          mockTaskRunning = false;
          const { runCronjob } = require('../server-cronjob');
          runCronjob(logger);
        });

        it('initialise CronJob', () => {
          expect(mockCronJob).toHaveBeenCalledWith(
            '* * * * * *',
            expect.any(Function),
            null,
            false,
            'Australia/Melbourne'
          );
        });

        it('triggers executeTrailingTradeIndicator', () => {
          expect(mockExecuteTrailingTradeIndicator).toHaveBeenCalled();
        });
      });
    });

    describe('all jobs disabled', () => {
      beforeEach(async () => {
        config.get = jest.fn(key => {
          switch (key) {
            default:
              return '';
          }
        });

        const { runCronjob } = require('../server-cronjob');
        runCronjob(logger);
      });

      it('does not initialise CronJob', () => {
        expect(mockCronJob).not.toHaveBeenCalled();
      });

      it('does not trigger executeAlive', () => {
        expect(mockExecuteAlive).not.toHaveBeenCalled();
      });

      it('does not trigger executeTrailingTrade', () => {
        expect(mockExecuteTrailingTrade).not.toHaveBeenCalled();
      });
    });
  });

  describe('job is timeout', () => {
    beforeEach(async () => {
      jest.clearAllMocks().resetModules();
      jest.useFakeTimers();
      jest.mock('config');

      cache.hset = jest.fn().mockResolvedValue(true);

      mockExecuteAlive = jest.fn().mockResolvedValue(true);
      mockExecuteTrailingTrade = jest.fn().mockImplementation(() => {
        setTimeout(() => Promise.resolve(true), 30000);
      });
      mockExecuteTrailingTradeIndicator = jest.fn().mockResolvedValue(true);

      jest.mock('../cronjob', () => ({
        executeAlive: mockExecuteAlive,
        executeTrailingTrade: mockExecuteTrailingTrade,
        executeTrailingTradeIndicator: mockExecuteTrailingTradeIndicator
      }));

      mockCronJob = jest
        .fn()
        .mockImplementation(
          (_cronTime, onTick, _onComplete, _start, _timeZone) => ({
            taskRunning: mockTaskRunning,
            start: jest.fn(() => onTick())
          })
        );

      jest.mock('cron', () => ({
        CronJob: mockCronJob
      }));
      config = require('config');

      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.trailingTrade.enabled':
            return true;
          case 'jobs.trailingTrade.cronTime':
            return '* * * * * *';
          case 'tz':
            return 'Australia/Melbourne';
          default:
            return `value-${key}`;
        }
      });
    });

    describe('when task is not running', () => {
      beforeEach(() => {
        mockTaskRunning = false;
        const { runCronjob } = require('../server-cronjob');
        runCronjob(logger);

        jest.advanceTimersByTime(20001);
      });

      it('initialise CronJob', () => {
        expect(mockCronJob).toHaveBeenCalledWith(
          '* * * * * *',
          expect.any(Function),
          null,
          false,
          'Australia/Melbourne'
        );
      });

      it('triggers executeTrailingTrade', () => {
        expect(mockExecuteTrailingTrade).toHaveBeenCalled();
      });
    });
  });
});
