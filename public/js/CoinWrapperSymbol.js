/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSymbol extends React.Component {
  isMonitoring() {
    const { configuration, symbolInfo } = this.props;

    const { symbol } = symbolInfo;
    const { symbols } = configuration;
    return symbols.includes(symbol);
  }

  render() {
    const {
      symbol,
      symbolInfo,
      lastCandle,
      baseAssetPrecision,
      quotePrecision,
      filterLotSize,
      filterMinNotional,
      filterPrice,
      baseAssetStepSize,
      quoteAssetTickSize,
      baseAssetBalance,
      quoteAssetBalance,
      configuration: globalConfiguration,
      sendWebSocket,
      jsonStrings
    } = this.props;

    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-symbol'>
        <div className='coin-info-column coin-info-column-name'>
          <a
            href={`https://www.binance.com/en/trade/${symbol}?layout=pro`}
            target='_blank'
            rel='noreferrer'
            className='coin-symbol'>
            {symbol}
          </a>
          {_.isEmpty(symbolInfo.buy.trend) === false
            ? [
                symbolInfo.buy.trend.signedTrendDiff === 1 ? (
                  <i class='gg-chevron-double-up'></i>
                ) : (
                  [
                    symbolInfo.buy.trend.signedTrendDiff === -1 ? (
                      <i class='gg-chevron-double-down'></i>
                    ) : (
                      ''
                    )
                  ]
                )
              ]
            : ''}
        </div>
        <div className='coin-info-column coin-info-column-icon'>
          <CoinWrapperManualTrade
            symbol={symbol}
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
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />
          {this.isMonitoring() && (
            <Spinner
              animation='border'
              size='sm'
              className='coin-info-spinner'
            />
          )}
          <SymbolSettingIcon
            symbolInfo={symbolInfo}
            globalConfiguration={globalConfiguration}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />
          <SymbolDeleteIcon
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            jsonStrings={jsonStrings}
          />
        </div>
      </div>
    );
  }
}
