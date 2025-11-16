# Momentum Trading Feature

## Overview

The momentum trading feature adds an automated momentum detection and trading strategy to the Binance Trading Bot. This feature works **alongside** the existing grid trading strategy and can be enabled/disabled independently.

## ⚠️ Important Notes

- **This is for SPOT trading only** - NOT perpetual/futures contracts
- **No leverage** is used
- The bot does NOT support perpetual contracts or futures trading
- Momentum trades are executed using **market orders** by default for quick entry/exit
- Each symbol can only have **one active momentum trade** at a time

## How It Works

### Detection Phase

The bot continuously monitors market conditions using multiple technical indicators:

1. **RSI (Relative Strength Index)** - Identifies overbought/oversold conditions
2. **MACD (Moving Average Convergence Divergence)** - Detects momentum shifts
3. **Volume Analysis** - Confirms momentum with volume spikes
4. **Price Momentum** - Tracks recent price changes

### Entry Signals

A momentum buy signal is triggered when:
- RSI indicates buying opportunity (< 40 by default)
- MACD shows bullish crossover
- Volume is significantly higher than average (1.5x+)
- Multiple timeframes confirm the momentum (15m and 1h by default)

### Holding Period

- **Minimum holding time**: 5 minutes (configurable)
- **Maximum holding time**: 2 hours (120 minutes, configurable)
- Trades can exit earlier if profit target or stop loss is hit

### Exit Conditions

The bot will automatically exit a momentum trade when ANY of these conditions are met:

1. **Profit Target**: Default +1.5% profit
2. **Stop Loss**: Default -1.0% loss
3. **Trailing Stop**: 0.5% drawdown from highest price reached
4. **Time-based Exit**: Maximum 2 hours holding time
5. **Minimum Time**: At least 5 minutes before taking profit

## Configuration

### Enable Momentum Trading

Edit your `config/default.json` (or symbol-specific configuration):

```json
{
  "jobs": {
    "trailingTrade": {
      "momentum": {
        "enabled": true,
        "timeframes": ["15m", "1h"],
        "buyAmount": 100,
        "orderType": "MARKET",
        "rsiPeriod": 14,
        "rsiBuyThreshold": 40,
        "rsiSellThreshold": 70,
        "volumeMultiplier": 1.5,
        "maxHoldingMinutes": 120,
        "minHoldingMinutes": 5,
        "profitTarget": 1.5,
        "stopLoss": -1.0,
        "trailingStopPercentage": 0.5
      }
    }
  }
}
```

### Configuration Parameters

| Parameter | Description | Default | Recommended Range |
|-----------|-------------|---------|-------------------|
| `enabled` | Enable/disable momentum trading | `false` | `true`/`false` |
| `timeframes` | Timeframes to analyze for momentum | `["15m", "1h"]` | Any valid intervals |
| `buyAmount` | USDT amount per momentum trade | `100` | 10-1000 |
| `orderType` | Order type (MARKET or LIMIT) | `MARKET` | `MARKET` preferred |
| `rsiPeriod` | RSI calculation period | `14` | 7-21 |
| `rsiBuyThreshold` | RSI buy signal threshold | `40` | 30-50 |
| `rsiSellThreshold` | RSI sell signal threshold | `70` | 60-80 |
| `volumeMultiplier` | Volume spike multiplier | `1.5` | 1.2-3.0 |
| `maxHoldingMinutes` | Maximum trade duration | `120` | 60-240 |
| `minHoldingMinutes` | Minimum trade duration | `5` | 5-30 |
| `profitTarget` | Profit target percentage | `1.5` | 0.5-5.0 |
| `stopLoss` | Stop loss percentage (negative) | `-1.0` | -0.5 to -5.0 |
| `trailingStopPercentage` | Trailing stop percentage | `0.5` | 0.3-2.0 |

## Trading Strategy Examples

### Conservative Strategy (Lower Risk)
```json
{
  "buyAmount": 50,
  "profitTarget": 1.0,
  "stopLoss": -0.5,
  "maxHoldingMinutes": 60,
  "rsiBuyThreshold": 35
}
```

### Aggressive Strategy (Higher Risk)
```json
{
  "buyAmount": 200,
  "profitTarget": 3.0,
  "stopLoss": -2.0,
  "maxHoldingMinutes": 180,
  "rsiBuyThreshold": 45
}
```

### Scalping Strategy (Quick Trades)
```json
{
  "buyAmount": 100,
  "profitTarget": 0.8,
  "stopLoss": -0.5,
  "maxHoldingMinutes": 30,
  "minHoldingMinutes": 2,
  "trailingStopPercentage": 0.3
}
```

## How It Integrates with Grid Trading

The momentum trading feature runs **in parallel** with the grid trading strategy:

- Grid trading handles the primary buy/sell logic based on price levels
- Momentum trading looks for short-term opportunities
- Both strategies share the same balance but operate independently
- If momentum detects a signal, it takes priority for that execution cycle
- Grid trading resumes normally after momentum trade completes

## Monitoring Momentum Trades

### Active Trade Information

When a momentum trade is active, the bot stores:
- Entry price and time
- Entry amount and quantity
- Highest price reached (for trailing stop)
- Signal strength and indicators that triggered entry
- Order ID for tracking

### Trade History

Completed momentum trades are saved with:
- Entry and exit prices
- Profit/loss percentage and amount
- Holding duration
- Exit reason (profit target, stop loss, time limit, etc.)
- Technical signals at entry

### Slack Notifications

The bot sends notifications for:
- 🚀 **Momentum Buy Signal** - When entering a trade
- ✅ **Buy Order Executed** - Confirmation with entry details
- 📊 **Sell Signal** - When exit conditions are met
- 🎉 **Trade Completed** (profit) - Exit with profit details
- 😔 **Trade Completed** (loss) - Exit with loss details
- ❌ **Order Failed** - If any errors occur

## Example Workflow

1. **Detection** (every second):
   - Bot analyzes 15m and 1h candles
   - Calculates RSI, MACD, volume metrics
   - Checks if momentum threshold is met

2. **Entry** (when signal detected):
   - Verifies no existing momentum trade is active
   - Places market buy order for configured amount
   - Stores trade data in cache
   - Sends notification

3. **Monitoring** (every second while holding):
   - Updates highest price if current price is higher
   - Checks exit conditions
   - Updates trailing stop levels

4. **Exit** (when condition met):
   - Places market sell order
   - Calculates profit/loss
   - Saves to trade history
   - Clears active trade from cache
   - Sends completion notification

## Performance Tips

1. **Start Small**: Begin with small `buyAmount` (e.g., $50) to test
2. **Monitor Performance**: Check trade history after 1-2 weeks
3. **Adjust Thresholds**: Fine-tune based on market conditions
4. **Volatile Coins**: Lower `profitTarget` and `stopLoss` for volatile pairs
5. **Stable Coins**: Use tighter stops with longer holding periods
6. **Market Conditions**: Disable during ranging markets, enable during trending

## Risk Management

- Maximum loss per trade is limited by `stopLoss` setting
- Each trade uses a fixed `buyAmount` - never more
- Trailing stop protects profits once trade is profitable
- Time limit prevents indefinite holding
- Only one active momentum trade per symbol at a time

## Troubleshooting

### Momentum not triggering
- Check if `enabled: true` in configuration
- Verify sufficient candle data is being collected
- Lower `rsiBuyThreshold` for more signals
- Check Slack/logs for detection messages

### Trades exiting too quickly
- Increase `minHoldingMinutes`
- Widen `trailingStopPercentage`
- Check if `stopLoss` is too tight

### Trades holding too long
- Decrease `maxHoldingMinutes`
- Lower `profitTarget` for quicker exits
- Tighten `trailingStopPercentage`

### Not enough balance
- Reduce `buyAmount`
- Check available USDT balance
- Ensure grid trading isn't using all funds

## Files Added/Modified

### New Files:
- `/app/cronjob/trailingTradeHelper/momentum.js` - Core momentum calculation functions
- `/app/cronjob/trailingTrade/step/check-momentum.js` - Momentum detection step
- `/app/cronjob/trailingTrade/step/place-momentum-buy-order.js` - Entry order placement
- `/app/cronjob/trailingTrade/step/place-momentum-sell-order.js` - Exit order placement

### Modified Files:
- `/app/cronjob/trailingTrade/steps.js` - Export new steps
- `/app/cronjob/trailingTrade.js` - Add momentum steps to trading loop
- `/app/cronjob/trailingTradeIndicator/step/get-indicators.js` - Fetch momentum candles
- `/config/default.json` - Add momentum configuration

## Next Steps

1. Set `enabled: true` in your configuration
2. Configure your desired parameters
3. Restart the bot
4. Monitor Slack notifications for momentum signals
5. Review trade history after a few days
6. Adjust parameters based on performance

## FAQ

**Q: Can I use this with perpetual/futures contracts?**
A: No, this bot only supports SPOT trading. It does not work with perpetual contracts or futures.

**Q: Does this use leverage?**
A: No, this is spot trading only. No leverage is used.

**Q: How many momentum trades can run at once?**
A: One active momentum trade per symbol. Multiple symbols can each have their own momentum trade.

**Q: Will this interfere with grid trading?**
A: No, they work independently. Momentum trades use a separate tracking system.

**Q: What happens if I run out of balance?**
A: The bot will skip momentum signals if insufficient USDT is available.

**Q: Can I manually close a momentum trade?**
A: Yes, you can manually sell the position. The bot will detect the missing balance and clear the cached trade data.

**Q: How do I view past momentum trades?**
A: Trade history is stored in Redis cache under `trailing-trade-momentum-history` key.

## Support

For issues or questions:
1. Check the logs for error messages
2. Verify configuration syntax is correct
3. Ensure sufficient balance is available
4. Review Slack notifications for clues
5. Open an issue on the GitHub repository

