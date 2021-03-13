/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSell extends React.Component {
  render() {
    const { symbolInfo, symbolConfiguration, sendWebSocket } = this.props;

    if (symbolInfo.openOrder.type !== null) {
      return null;
    }

    if (symbolInfo.sell.lastBuyPrice > 0) {
      return (
        <div className='coin-info-sub-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <div className='coin-info-label'>
              Sell Signal{' '}
              <span className='coin-info-value'>
                {symbolConfiguration.sell.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>
            {moment(symbolInfo.sell.updatedAt).isValid() ? (
              <HightlightChange
                className='coin-info-value'
                title={symbolInfo.sell.updatedAt}>
                {moment(symbolInfo.sell.updatedAt).format('HH:mm:ss')}
              </HightlightChange>
            ) : (
              ''
            )}
          </div>
          {symbolConfiguration.sell.enabled === false ? (
            <div className='coin-info-column coin-info-column-sell-enabled'>
              <HightlightChange className='coin-info-message text-muted'>
                Trading is disabled.
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {symbolInfo.sell.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Current price:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.sell.currentPrice.toFixed(symbolInfo.precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <CoinWrapperSellLastBuyPrice
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}></CoinWrapperSellLastBuyPrice>
          {symbolInfo.sell.currentProfit ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Profit/Loss:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.sell.currentProfit.toFixed(2)}{' '}
                {symbolInfo.quoteAsset} (
                {symbolInfo.sell.currentProfitPercentage.toFixed(2)}
                %)
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          {symbolInfo.sell.minimumSellingPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>
                Trigger price (
                {(
                  (symbolConfiguration.stopLossLimit.lastBuyPercentage - 1) *
                  100
                ).toFixed(2)}
                %):
              </span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.sell.minimumSellingPrice.toFixed(
                  symbolInfo.precision
                )}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {symbolInfo.sell.difference ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Difference to sell:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.sell.difference.toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          <div className='coin-info-column coin-info-column-message'>
            <HightlightChange className='coin-info-message'>
              {symbolInfo.sell.processMessage}
            </HightlightChange>
          </div>
        </div>
      );
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <div className='coin-info-label'>
            Sell Signal{' '}
            <span className='coin-info-value'>
              {symbolConfiguration.sell.enabled ? (
                <i className='fa fa-toggle-on'></i>
              ) : (
                <i className='fa fa-toggle-off'></i>
              )}
            </span>
          </div>
          <span className='coin-info-value'></span>
        </div>
        {symbolConfiguration.sell.enabled === false ? (
          <div className='coin-info-column coin-info-column-sell-enabled'>
            <HightlightChange className='coin-info-message text-muted'>
              Trading is disabled.
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        <CoinWrapperSellLastBuyPrice
          symbolInfo={symbolInfo}
          sendWebSocket={sendWebSocket}></CoinWrapperSellLastBuyPrice>
      </div>
    );
  }
}
