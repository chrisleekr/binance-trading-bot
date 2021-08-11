/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapper extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, configuration, isAuthenticated } =
      this.props;

    const {
      symbol,
      lastCandle,
      symbolInfo: {
        quoteAsset,
        baseAssetPrecision,
        quotePrecision,
        filterPrice,
        filterLotSize,
        filterMinNotional
      },
      baseAssetBalance,
      quoteAssetBalance
    } = symbolInfo;

    const baseAssetStepSize =
      parseFloat(filterLotSize.stepSize) === 1
        ? 0
        : filterLotSize.stepSize.indexOf(1) - 1;
    const quoteAssetTickSize =
      parseFloat(filterPrice.tickSize) === 1
        ? 0
        : filterPrice.tickSize.indexOf(1) - 1;

    const className = 'coin-wrapper ' + this.props.extraClassName;

    return (
      <div className={className} data-symbol={symbolInfo.symbol}>
        <div className='coin-info-wrapper'>
          <CoinWrapperSymbol
            symbol={symbol}
            symbolInfo={symbolInfo}
            lastCandle={lastCandle}
            quoteAsset={quoteAsset}
            baseAssetPrecision={baseAssetPrecision}
            quotePrecision={quotePrecision}
            filterLotSize={filterLotSize}
            filterMinNotional={filterMinNotional}
            filterPrice={filterPrice}
            baseAssetStepSize={baseAssetStepSize}
            quoteAssetTickSize={quoteAssetTickSize}
            baseAssetBalance={baseAssetBalance}
            quoteAssetBalance={quoteAssetBalance}
            configuration={configuration}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />
          <CoinWrapperBalance symbolInfo={symbolInfo} />
          <CoinWrapperSetting
            symbolInfo={symbolInfo}
            configuration={configuration}
            sendWebSocket={sendWebSocket}
          />

          <CoinWrapperAction
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />

          <CoinWrapperBuySignal
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />
          <CoinWrapperBuyOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />

          <CoinWrapperSellSignal
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />
          <CoinWrapperSellOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />
        </div>
      </div>
    );
  }
}
