# Tradingview Technical Analysis (tradingview-ta)
# Author: deathlyface (https://github.com/deathlyface)
# Rewritten from https://www.tradingview.com/static/bundles/technicals.f2e6e6a51aebb6cd46f8.js
# License: MIT

class Recommendation:
    buy = "BUY"
    strong_buy = "STRONG_BUY"
    sell = "SELL"
    strong_sell = "STRONG_SELL"
    neutral = "NEUTRAL"
    error = "ERROR"

class Compute:
    def MA(ma, close):
        """Compute Moving Average

        Args:
            ma (float): MA value
            close (float): Close value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (ma < close):
            return Recommendation.buy
        elif (ma > close):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def RSI(rsi, rsi1):
        """Compute Relative Strength Index

        Args:
            rsi (float): RSI value
            rsi1 (float): RSI[1] value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (rsi < 30 and rsi1 < rsi):
            return Recommendation.buy
        elif (rsi > 70 and rsi1 > rsi):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def Stoch(k, d, k1, d1):
        """Compute Stochastic

        Args:
            k (float): Stoch.K value
            d (float): Stoch.D value
            k1 (float): Stoch.K[1] value
            d1 (float): Stoch.D[1] value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (k < 20 and d < 20 and k > d and k1 < d1):
            return Recommendation.buy
        elif (k > 80 and d > 80 and k < d and k1 > d1):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def CCI20(cci20, cci201):
        """Compute Commodity Channel Index 20

        Args:
            cci20 (float): CCI20 value
            cci201 ([type]): CCI20[1] value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (cci20 < -100 and cci20 > cci201):
            return Recommendation.buy
        elif (cci20 > 100 and cci20 < cci201):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def ADX(adx, adxpdi, adxndi, adxpdi1, adxndi1):
        """Compute Average Directional Index

        Args:
            adx (float): ADX value
            adxpdi (float): ADX+DI value
            adxndi (float): ADX-DI value
            adxpdi1 (float): ADX+DI[1] value
            adxndi1 (float): ADX-DI[1] value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (adx > 20 and adxpdi1 < adxndi1 and adxpdi > adxndi):
            return Recommendation.buy
        elif (adx > 20 and adxpdi1 > adxndi1 and adxpdi < adxndi):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def AO(ao, ao1, ao2):
        """Compute Awesome Oscillator

        Args:
            ao (float): AO value
            ao1 (float): AO[1] value
            ao2 (float): AO[2] value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (ao > 0 and ao1 < 0) or (ao > 0 and ao1 > 0 and ao > ao1 and ao2 > ao1):
            return Recommendation.buy
        elif (ao < 0 and ao1 > 0) or (ao < 0 and ao1 < 0 and ao < ao1 and ao2 < ao1):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def Mom(mom, mom1):
        """Compute Momentum

        Args:
            mom (float): Mom value
            mom1 (float): Mom[1] value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (mom < mom1):
            return Recommendation.sell
        elif (mom > mom1):
            return Recommendation.buy
        else:
            return Recommendation.neutral

    def MACD(macd, signal):
        """Compute Moving Average Convergence/Divergence

        Args:
            macd (float): MACD.macd value
            signal (float): MACD.signal value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (macd > signal):
            return Recommendation.buy
        elif (macd < signal):
            return Recommendation.sell
        else:
            return Recommendation.neutral
        
    def BBBuy(close, bblower):
        """Compute Bull Bear Buy

        Args:
            close (float): close value
            bblower (float): BB.lower value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (close < bblower):
            return Recommendation.buy
        else:
            return Recommendation.neutral

    def BBSell(close, bbupper):
        """Compute Bull Bear Sell

        Args:
            close (float): close value
            bbupper (float): BB.upper value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (close > bbupper):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def PSAR(psar, open):
        """Compute Parabolic Stop-And-Reverse

        Args:
            psar (float): P.SAR value
            open (float): open value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (psar < open):
            return Recommendation.buy
        elif (psar > open):
            return Recommendation.sell
        else:
            return Recommendation.neutral

    def Recommend(value):
        """Compute Recommend

        Args:
            value (float): recommend value

        Returns:
            string: "STRONG_BUY", "BUY", "NEUTRAL", "SELL", "STRONG_SELL", or "ERROR"
        """
        if value >= -1 and value < -.5:
            return Recommendation.strong_sell
        elif value >= -.5 and value < -.1:
            return Recommendation.sell
        elif value >= -.1 and value <= .1:
            return Recommendation.neutral
        elif value > .1 and value <= .5 :
            return Recommendation.buy
        elif value > .5 and value <= 1:
            return Recommendation.strong_buy
        else:
            return Recommendation.error

    def Simple(value):
        """Compute Simple

        Args:
            value (float): Rec.X value

        Returns:
            string: "BUY", "SELL", or "NEUTRAL"
        """
        if (value == -1):
            return Recommendation.sell
        elif (value == 1):
            return Recommendation.buy
        else:
            return Recommendation.neutral
