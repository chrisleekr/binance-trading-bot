/* eslint-disable global-require */

describe('momentum.js', () => {
  let momentum;

  beforeEach(() => {
    jest.clearAllMocks().resetModules();
    momentum = require('../momentum');
  });

  describe('calculateRSI', () => {
    it('calculates RSI correctly for uptrend', () => {
      const closes = [
        44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
        46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64
      ];
      const rsi = momentum.calculateRSI(closes, 14);
      expect(rsi).toBeGreaterThan(40);
      expect(rsi).toBeLessThan(70);
    });

    it('returns null for insufficient data', () => {
      const closes = [44, 44.34, 44.09];
      const rsi = momentum.calculateRSI(closes, 14);
      expect(rsi).toBeNull();
    });

    it('returns 100 for all gains', () => {
      const closes = [
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25
      ];
      const rsi = momentum.calculateRSI(closes, 14);
      expect(rsi).toBe(100);
    });
  });

  describe('calculateEMA', () => {
    it('calculates EMA correctly', () => {
      const data = [22, 23, 24, 25, 26, 27, 28, 29, 30];
      const ema = momentum.calculateEMA(data, 5);
      expect(ema).toBeGreaterThan(26);
      expect(ema).toBeLessThan(30);
    });

    it('returns null for insufficient data', () => {
      const data = [22, 23];
      const ema = momentum.calculateEMA(data, 5);
      expect(ema).toBeNull();
    });
  });

  describe('calculateMACD', () => {
    it('calculates MACD correctly', () => {
      const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
      const macd = momentum.calculateMACD(closes);
      expect(macd.macd).not.toBeNull();
      expect(macd.signal).not.toBeNull();
      expect(macd.histogram).not.toBeNull();
    });

    it('returns null values for insufficient data', () => {
      const closes = [100, 101, 102];
      const macd = momentum.calculateMACD(closes);
      expect(macd.macd).toBeNull();
      expect(macd.signal).toBeNull();
      expect(macd.histogram).toBeNull();
    });
  });

  describe('calculateVolumeMomentum', () => {
    it('calculates volume ratio correctly', () => {
      const volumes = Array.from({ length: 25 }, () => 1000);
      volumes[24] = 2000; // Current volume is 2x average
      const ratio = momentum.calculateVolumeMomentum(volumes, 20);
      expect(ratio).toBeGreaterThan(1.8);
      expect(ratio).toBeLessThan(2.1);
    });

    it('returns 1 for insufficient data', () => {
      const volumes = [1000, 1100];
      const ratio = momentum.calculateVolumeMomentum(volumes, 20);
      expect(ratio).toBe(1);
    });
  });

  describe('detectMomentum', () => {
    it('detects bullish momentum with strong signals', () => {
      // Create data that should trigger momentum
      const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.2);
      const highs = closes.map(c => c + 1);
      const lows = closes.map(c => c - 1);
      const volumes = Array.from({ length: 50 }, () => 1000);
      volumes[49] = 2000; // High volume at end

      const result = momentum.detectMomentum({
        close: closes,
        high: highs,
        low: lows,
        volume: volumes
      });

      expect(result).toHaveProperty('hasMomentum');
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('strength');
      expect(result).toHaveProperty('signals');
      expect(result).toHaveProperty('indicators');
    });

    it('returns no momentum for insufficient data', () => {
      const result = momentum.detectMomentum({
        close: [100, 101, 102],
        high: [101, 102, 103],
        low: [99, 100, 101],
        volume: [1000, 1000, 1000]
      });

      expect(result.hasMomentum).toBe(false);
      expect(result.reason).toBe('Insufficient data');
    });

    it('detects no momentum in ranging market', () => {
      const closes = Array.from({ length: 50 }, () => 100);
      const highs = closes.map(c => c + 0.5);
      const lows = closes.map(c => c - 0.5);
      const volumes = Array.from({ length: 50 }, () => 1000);

      const result = momentum.detectMomentum({
        close: closes,
        high: highs,
        low: lows,
        volume: volumes
      });

      expect(result.hasMomentum).toBe(false);
    });
  });

  describe('shouldExitMomentumTrade', () => {
    const baseEntryData = {
      entryPrice: 100,
      entryTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
      highestPrice: 102
    };

    it('exits when profit target is reached', () => {
      const result = momentum.shouldExitMomentumTrade(
        baseEntryData,
        { currentPrice: 101.5 },
        { profitTarget: 1.5, minHoldingMinutes: 5 }
      );

      expect(result.exit).toBe(true);
      expect(result.reason).toContain('Profit target');
      expect(result.profitPercentage).toBeCloseTo(1.5, 1);
    });

    it('exits when stop loss is hit', () => {
      const result = momentum.shouldExitMomentumTrade(
        baseEntryData,
        { currentPrice: 98.5 },
        { stopLoss: -1.0 }
      );

      expect(result.exit).toBe(true);
      expect(result.reason).toContain('Stop loss');
    });

    it('exits when maximum holding time is reached', () => {
      const oldEntryData = {
        ...baseEntryData,
        entryTime: new Date(Date.now() - 125 * 60 * 1000).toISOString() // 125 minutes ago
      };

      const result = momentum.shouldExitMomentumTrade(
        oldEntryData,
        { currentPrice: 100.5 },
        { maxHoldingMinutes: 120 }
      );

      expect(result.exit).toBe(true);
      expect(result.reason).toContain('Maximum holding time');
    });

    it('exits when trailing stop is triggered', () => {
      const result = momentum.shouldExitMomentumTrade(
        baseEntryData,
        { currentPrice: 101.4 }, // Down 0.6% from high of 102
        { trailingStopPercentage: 0.5 }
      );

      expect(result.exit).toBe(true);
      expect(result.reason).toContain('Trailing stop');
    });

    it('does not exit before minimum holding time', () => {
      const recentEntry = {
        ...baseEntryData,
        entryTime: new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 minutes ago
      };

      const result = momentum.shouldExitMomentumTrade(
        recentEntry,
        { currentPrice: 101.5 },
        { profitTarget: 1.5, minHoldingMinutes: 5 }
      );

      expect(result.exit).toBe(false);
    });

    it('does not exit when conditions are not met', () => {
      const entryDataNoProfit = {
        entryPrice: 100,
        entryTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        highestPrice: 100.2 // Only slightly above entry
      };

      const result = momentum.shouldExitMomentumTrade(
        entryDataNoProfit,
        { currentPrice: 100.2 }, // At the high, no drawdown
        {
          profitTarget: 2.0,
          stopLoss: -2.0,
          maxHoldingMinutes: 120,
          trailingStopPercentage: 1.0
        }
      );

      expect(result.exit).toBe(false);
    });
  });
});
