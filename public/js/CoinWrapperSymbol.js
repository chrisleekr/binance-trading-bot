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

  isTradingOnBinance() {
    const { symbolInfo: symbolCache } = this.props;

    const {
      symbolInfo: { status }
    } = symbolCache;
    return status === 'TRADING';
  }

  render() {
    const {
      symbol,
      symbolInfo,
      lastCandle,
      quoteAsset,
      baseAssetPrecision,
      quotePrecision,
      filterLotSize,
      filterPrice,
      baseAssetStepSize,
      quoteAssetTickSize,
      baseAssetBalance,
      quoteAssetBalance,
      configuration: globalConfiguration,
      sendWebSocket,
      isAuthenticated
    } = this.props;

    let monitoringStatus = '';

    if (this.isMonitoring()) {
      if (this.isTradingOnBinance()) {
        monitoringStatus = (
          <Spinner animation='border' size='sm' className='coin-info-spinner' />
        );
      } else {
        monitoringStatus = (
          <OverlayTrigger
            trigger='click'
            key='monitoring-status-alert-overlay'
            placement='bottom'
            overlay={
              <Popover id='monitoring-status-alert-overlay-bottom'>
                <Popover.Content>
                  {symbol} exists in your monitoring list. However, it is not
                  active on Binance due to emergency downtime, due to it was
                  actually delisted or due to market move too fast. For more
                  details, check Binance announcements.
                  <br />
                  <br />
                  Current Status:{' '}
                  <span className='font-weight-bold'>
                    {symbolInfo.symbolInfo.status}
                  </span>
                </Popover.Content>
              </Popover>
            }>
            <Button
              variant='link'
              className='p-0 m-0 ml-1 d-inline-block'
              style={{ lineHeight: '17px' }}>
              <i className='fas fa-exclamation-circle mx-1 text-warning'></i>
            </Button>
          </OverlayTrigger>
        );
      }
    }

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
          {monitoringStatus}
        </div>
        <div className='coin-info-column coin-info-column-icon'>
          <SymbolManualTradeIcon
            symbol={symbol}
            lastCandle={lastCandle}
            baseAssetPrecision={baseAssetPrecision}
            quotePrecision={quotePrecision}
            filterLotSize={filterLotSize}
            filterPrice={filterPrice}
            baseAssetStepSize={baseAssetStepSize}
            quoteAssetTickSize={quoteAssetTickSize}
            baseAssetBalance={baseAssetBalance}
            quoteAssetBalance={quoteAssetBalance}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />

          <SymbolGridTradeArchiveIcon
            symbol={symbol}
            quoteAsset={quoteAsset}
            quoteAssetTickSize={quoteAssetTickSize}
            isAuthenticated={isAuthenticated}
          />

          <SymbolLogsIcon symbol={symbol} isAuthenticated={isAuthenticated} />

          <SymbolSettingIcon
            symbolInfo={symbolInfo}
            globalConfiguration={globalConfiguration}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />
          <SymbolDeleteIcon
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}
            isAuthenticated={isAuthenticated}
          />
        </div>
      </div>
    );
  }
}
