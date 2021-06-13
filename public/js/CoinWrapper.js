/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapper extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, configuration, jsonStrings } = this.props;

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

    if (_.isEmpty(jsonStrings)) {
      return '';
    }

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
            jsonStrings={jsonStrings}
          />
          <CoinWrapperBalance
            symbolInfo={symbolInfo}
            jsonStrings={jsonStrings}
          />
          <CoinWrapperSetting
            symbolInfo={symbolInfo}
            configuration={configuration}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />

          <CoinWrapperAction
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />

          <CoinWrapperBuySignal
            symbolInfo={symbolInfo}
            jsonStrings={jsonStrings}
          />
          <CoinWrapperBuyOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />

          <CoinWrapperSellSignal
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />
          <CoinWrapperSellOrders
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />
        </div>
      </div>
    );
  }
}
