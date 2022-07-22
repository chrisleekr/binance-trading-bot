const { logger, mongo } = require('../../../helpers');

const order = require('../order');

describe('order.js', () => {
  let result;
  beforeEach(async () => {
    jest.clearAllMocks().resetModules();
  });

  describe('getGridTradeOrder', () => {
    describe('when order exists', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue({
          order: {
            orderId: '123'
          }
        });

        result = await order.getGridTradeOrder(logger, 'BTCUSDT');
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade-orders',
          {
            key: 'BTCUSDT'
          }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          orderId: '123'
        });
      });
    });

    describe('when order does not exist', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue({ some: 'value' });

        result = await order.getGridTradeOrder(logger, 'BTCUSDT');
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade-orders',
          {
            key: 'BTCUSDT'
          }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual(null);
      });
    });
  });

  describe('saveGridTradeOrder', () => {
    beforeEach(async () => {
      mongo.upsertOne = jest.fn().mockResolvedValue(true);

      result = await order.saveGridTradeOrder(logger, 'BTCUSDT', {
        orderId: '123'
      });
    });

    it('triggers saveGridTradeOrder', () => {
      expect(mongo.upsertOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-grid-trade-orders',
        { key: 'BTCUSDT' },
        {
          key: 'BTCUSDT',
          order: {
            orderId: '123'
          }
        }
      );
    });
  });

  describe('deleteGridTradeOrder', () => {
    beforeEach(async () => {
      mongo.deleteOne = jest.fn().mockResolvedValue(true);

      result = await order.deleteGridTradeOrder(logger, 'BTCUSDT');
    });

    it('triggers mongo.deleteOne', () => {
      expect(mongo.deleteOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-grid-trade-orders',
        { key: 'BTCUSDT' }
      );
    });
  });

  describe('getManualOrders', () => {
    beforeEach(async () => {
      mongo.findAll = jest.fn().mockResolvedValue([{ orderId: 123 }]);

      result = await order.getManualOrders(logger, 'BTCUSDT');
    });

    it('triggers mongo.findAll', () => {
      expect(mongo.findAll).toHaveBeenCalledWith(
        logger,
        'trailing-trade-manual-orders',
        { symbol: 'BTCUSDT' }
      );
    });
  });

  describe('getManualOrder', () => {
    describe('when order is avilable', () => {
      beforeEach(async () => {
        mongo.findOne = jest
          .fn()
          .mockResolvedValue({ order: { orderId: '123' } });

        result = await order.getManualOrder(logger, 'BTCUSDT', '123');
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-manual-orders',
          { symbol: 'BTCUSDT', orderId: '123' }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({ orderId: '123' });
      });
    });

    describe('when order is not avilable', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue(null);

        result = await order.getManualOrder(logger, 'BTCUSDT', '123');
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-manual-orders',
          { symbol: 'BTCUSDT', orderId: '123' }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual(null);
      });
    });
  });

  describe('saveManualOrder', () => {
    beforeEach(async () => {
      mongo.upsertOne = jest.fn().mockResolvedValue(true);

      result = await order.saveManualOrder(logger, 'BTCUSDT', '123', {
        orderId: '123'
      });
    });

    it('triggers mongo.upsertOne', () => {
      expect(mongo.upsertOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-manual-orders',
        { symbol: 'BTCUSDT', orderId: '123' },
        { symbol: 'BTCUSDT', orderId: '123', order: { orderId: '123' } }
      );
    });
  });

  describe('deleteManualOrder', () => {
    beforeEach(async () => {
      mongo.deleteOne = jest.fn().mockResolvedValue(true);

      result = await order.deleteManualOrder(logger, 'BTCUSDT', '123');
    });

    it('triggers mongo.deleteOne', () => {
      expect(mongo.deleteOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-manual-orders',
        { symbol: 'BTCUSDT', orderId: '123' }
      );
    });
  });

  describe('getGridTradeLastOrder', () => {
    describe('when order is avilable', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue({
          order: {
            id: 'order-123'
          }
        });

        result = await order.getGridTradeLastOrder(logger, 'BTCUSDT', 'buy');
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade-orders',
          { key: 'BTCUSDT-grid-trade-last-buy-order' }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({
          id: 'order-123'
        });
      });
    });

    describe('when order is not available', () => {
      beforeEach(async () => {
        mongo.findOne = jest.fn().mockResolvedValue(null);

        result = await order.getGridTradeLastOrder(logger, 'BTCUSDT', 'buy');
      });

      it('triggers mongo.findOne', () => {
        expect(mongo.findOne).toHaveBeenCalledWith(
          logger,
          'trailing-trade-grid-trade-orders',
          { key: 'BTCUSDT-grid-trade-last-buy-order' }
        );
      });

      it('returns expected result', () => {
        expect(result).toStrictEqual({});
      });
    });
  });

  describe('updateGridTradeLastOrder', () => {
    beforeEach(async () => {
      mongo.upsertOne = jest.fn().mockResolvedValue(true);

      result = await order.updateGridTradeLastOrder(logger, 'BTCUSDT', 'buy', {
        id: 'new-order'
      });
    });

    it('triggers mongo.upsertOne', () => {
      expect(mongo.upsertOne).toHaveBeenCalledWith(
        logger,
        'trailing-trade-grid-trade-orders',
        { key: 'BTCUSDT-grid-trade-last-buy-order' },
        {
          key: 'BTCUSDT-grid-trade-last-buy-order',
          order: { id: 'new-order' }
        }
      );
    });
  });
});
