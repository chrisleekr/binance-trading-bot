/* eslint-disable global-require */
describe('server', () => {
  let config;

  let mockCronJob;
  let mockTaskRunning = false;

  let mockExecuteBbands;
  let mockExecuteAlive;
  let mockExecuteMacdStopChaser;
  let mockExecuteSimpleStopChaser;

  beforeEach(async () => {
    jest.clearAllMocks().resetModules();
    jest.mock('config');

    mockExecuteBbands = jest.fn().mockResolvedValue(true);
    mockExecuteAlive = jest.fn().mockResolvedValue(true);
    mockExecuteMacdStopChaser = jest.fn().mockResolvedValue(true);
    mockExecuteSimpleStopChaser = jest.fn().mockResolvedValue(true);

    jest.mock('../jobs', () => ({
      executeBbands: mockExecuteBbands,
      executeAlive: mockExecuteAlive,
      executeMacdStopChaser: mockExecuteMacdStopChaser,
      executeSimpleStopChaser: mockExecuteSimpleStopChaser
    }));

    mockCronJob = jest.fn().mockImplementation((_cronTime, onTick, _onComplete, _start, _timeZone) => ({
      taskRunning: mockTaskRunning,
      start: jest.fn(() => onTick())
    }));

    jest.mock('cron', () => ({
      CronJob: mockCronJob
    }));
    config = require('config');
  });

  describe('bbands', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.bbands.enabled':
            return true;
          case 'jobs.bbands.cronTime':
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
        require('../server');
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

      it('does not trigger executeBbands', () => {
        expect(mockExecuteBbands).not.toHaveBeenCalled();
      });
    });

    describe('when task is not running', () => {
      beforeEach(() => {
        mockTaskRunning = false;
        require('../server');
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

      it('triggers executeBbands', () => {
        expect(mockExecuteBbands).toHaveBeenCalled();
      });
    });
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
        require('../server');
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
        require('../server');
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

  describe('macdStopChaser', () => {
    beforeEach(async () => {
      config.get = jest.fn(key => {
        switch (key) {
          case 'jobs.macdStopChaser.enabled':
            return true;
          case 'jobs.macdStopChaser.cronTime':
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
        require('../server');
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

      it('does not trigger executeMacdStopChaser', () => {
        expect(mockExecuteMacdStopChaser).not.toHaveBeenCalled();
      });
    });

    describe('when task is not running', () => {
      beforeEach(() => {
        mockTaskRunning = false;
        require('../server');
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

      it('triggers executeMacdStopChaser', () => {
        expect(mockExecuteMacdStopChaser).toHaveBeenCalled();
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

      require('../server');
    });

    it('does not initialise CronJob', () => {
      expect(mockCronJob).not.toHaveBeenCalled();
    });

    it('does not trigger executeAlive', () => {
      expect(mockExecuteAlive).not.toHaveBeenCalled();
    });

    it('does not trigger executeBbands', () => {
      expect(mockExecuteBbands).not.toHaveBeenCalled();
    });

    it('does not trigger executeMacdStopChaser', () => {
      expect(mockExecuteMacdStopChaser).not.toHaveBeenCalled();
    });
  });
});
