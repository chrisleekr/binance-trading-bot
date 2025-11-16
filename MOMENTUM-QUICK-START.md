# Quick Start: Momentum Trading

## Enable Momentum Trading in 3 Steps

### Step 1: Update Configuration

Open `config/default.json` and find the `trailingTrade` section. Add or update the `momentum` configuration:

```json
{
  "jobs": {
    "trailingTrade": {
      "momentum": {
        "enabled": true,
        "buyAmount": 50,
        "profitTarget": 1.5,
        "stopLoss": -1.0,
        "maxHoldingMinutes": 120
      }
    }
  }
}
```

### Step 2: Restart the Bot

```bash
# If running with Docker Compose
docker-compose restart

# If running with npm
npm run dev
```

### Step 3: Monitor Slack/Logs

Watch for momentum signals:
- 🚀 Buy signals when momentum is detected
- 📊 Sell signals when exit conditions are met
- ✅ Trade completions with profit/loss

## Example Configurations

### Conservative (Recommended for Beginners)
```json
{
  "enabled": true,
  "buyAmount": 50,
  "profitTarget": 1.0,
  "stopLoss": -0.5,
  "maxHoldingMinutes": 60
}
```

### Balanced (Default)
```json
{
  "enabled": true,
  "buyAmount": 100,
  "profitTarget": 1.5,
  "stopLoss": -1.0,
  "maxHoldingMinutes": 120
}
```

### Aggressive
```json
{
  "enabled": true,
  "buyAmount": 200,
  "profitTarget": 3.0,
  "stopLoss": -2.0,
  "maxHoldingMinutes": 180
}
```

## What to Expect

- **Entry**: Bot detects momentum using RSI, MACD, and volume
- **Holding**: Monitors for 5 minutes to 2 hours
- **Exit**: Automatically sells at profit target, stop loss, or time limit
- **Frequency**: Varies based on market conditions (1-10 signals per day typically)

## Important Notes

- ✅ Works with **SPOT trading only**
- ❌ Does **NOT** support perpetuals/futures
- ❌ Does **NOT** use leverage
- 💰 Each trade uses the configured `buyAmount` in USDT
- 📊 One active momentum trade per symbol at a time
- 🔄 Works alongside grid trading strategy

## Troubleshooting

**No signals appearing?**
- Check if `enabled: true`
- Verify bot is running
- Check logs for "Momentum trading enabled" messages
- Try lowering `rsiBuyThreshold` to 35

**Trades exiting too fast?**
- Increase `minHoldingMinutes` to 10-15
- Widen `trailingStopPercentage` to 0.8-1.0

**Too many losses?**
- Tighten `stopLoss` to -0.5
- Lower `buyAmount` while testing
- Check market conditions (works best in trending markets)

## Full Documentation

See [MOMENTUM-TRADING.md](./MOMENTUM-TRADING.md) for complete documentation.

