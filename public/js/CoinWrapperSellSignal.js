/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSellSignal extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket } = this.props;
    const {
      symbolInfo: {
        filterPrice: { tickSize }
      },
      symbolConfiguration,
      quoteAssetBalance: { asset: quoteAsset },
      buy,
      sell
    } = symbolInfo;

    if (sell.openOrders.length > 0) {
      return '';
    }

    const precision = tickSize.indexOf(1) - 1;

    if (sell.lastBuyPrice > 0 && buy.openOrders.length === 0) {
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
            {moment(sell.updatedAt).isValid() ? (
              <HightlightChange
                className='coin-info-value'
                title={sell.updatedAt}>
                {moment(sell.updatedAt).format('HH:mm:ss')}
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
          {sell.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Current price:</span>
              <HightlightChange className='coin-info-value'>
                {(+sell.currentPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <CoinWrapperSellLastBuyPrice
            symbolInfo={symbolInfo}
            sendWebSocket={sendWebSocket}></CoinWrapperSellLastBuyPrice>
          {sell.currentProfit ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Profit/Loss:</span>
              <HightlightChange className='coin-info-value'>
                {(+sell.currentProfit).toFixed(2)} {quoteAsset} (
                {(+sell.currentProfitPercentage).toFixed(2)}
                %)
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          {sell.triggerPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>
                Trigger price (
                {(
                  (symbolConfiguration.sell.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %):
              </span>
              <HightlightChange className='coin-info-value'>
                {(+sell.triggerPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {sell.difference ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Difference to sell:</span>
              <HightlightChange className='coin-info-value'>
                {(+sell.difference).toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          <div className='coin-info-column coin-info-column-message'>
            <HightlightChange className='coin-info-message'>
              {sell.processMessage}
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
