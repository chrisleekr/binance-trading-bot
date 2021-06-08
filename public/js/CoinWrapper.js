/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapper extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, configuration } = this.props;

    const {
      symbol,
      lastCandle,
      symbolInfo: {
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
          />

          <CoinWrapperBuySignal symbolInfo={symbolInfo} />
          <CoinWrapperBuyOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />

          <CoinWrapperSellSignal
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />
          <CoinWrapperSellOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
          />
        </div>
      </div>
    );
  }
}
