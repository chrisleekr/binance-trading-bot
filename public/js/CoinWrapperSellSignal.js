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
      sell
    } = symbolInfo;

    if (sell.openOrders.length > 0) {
      return '';
    }

    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    if (sell.lastBuyPrice > 0) {
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
              </span>{' '}
              / Stop-Loss{' '}
              <span className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>
            {symbolConfiguration.sell.enabled === false ? (
              <HightlightChange className='coin-info-message text-muted'>
                Trading is disabled.
              </HightlightChange>
            ) : (
              ''
            )}
          </div>

          {sell.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Current price:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(sell.currentPrice).toFixed(precision)}
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
                {parseFloat(sell.currentProfit).toFixed(precision)} {quoteAsset}{' '}
                ({parseFloat(sell.currentProfitPercentage).toFixed(2)}
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
                &#62; Trigger price (
                {(
                  (symbolConfiguration.sell.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %):
              </span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(sell.triggerPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {sell.difference ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Difference to sell:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(sell.difference).toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}

          {symbolConfiguration.sell.stopLoss.enabled &&
          sell.stopLossTriggerPrice ? (
            <div className='d-flex flex-column w-100'>
              <div className='coin-info-column coin-info-column-price divider'></div>
              <div className='coin-info-column coin-info-column-stop-loss-price'>
                <span className='coin-info-label'>
                  Stop-Loss price (
                  {(
                    (symbolConfiguration.sell.stopLoss.maxLossPercentage - 1) *
                    100
                  ).toFixed(2)}
                  %) :
                </span>
                <HightlightChange className='coin-info-value'>
                  {parseFloat(sell.stopLossTriggerPrice).toFixed(precision)}
                </HightlightChange>
              </div>
              <div className='coin-info-column coin-info-column-stop-loss-price'>
                <span className='coin-info-label'>
                  Difference to Stop-Loss:
                </span>
                <HightlightChange className='coin-info-value'>
                  {parseFloat(sell.stopLossDifference).toFixed(2)}%
                </HightlightChange>
              </div>
            </div>
          ) : (
            ''
          )}
          {sell.processMessage ? (
            <div className='d-flex flex-column w-100'>
              <div className='coin-info-column coin-info-column-price divider'></div>
              <div className='coin-info-column coin-info-column-message'>
                <HightlightChange className='coin-info-message'>
                  {sell.processMessage}
                </HightlightChange>
              </div>
            </div>
          ) : (
            ''
          )}
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
            </span>{' '}
            / Stop-Loss{' '}
            {symbolConfiguration.sell.stopLoss.enabled
              ? `(` +
                (
                  (symbolConfiguration.sell.stopLoss.maxLossPercentage - 1) *
                  100
                ).toFixed(2) +
                `%) `
              : ''}
            <span className='coin-info-value'>
              {symbolConfiguration.sell.stopLoss.enabled ? (
                <i className='fa fa-toggle-on'></i>
              ) : (
                <i className='fa fa-toggle-off'></i>
              )}
            </span>
          </div>
          {symbolConfiguration.sell.enabled === false ? (
            <HightlightChange className='coin-info-message text-muted'>
              Trading is disabled.
            </HightlightChange>
          ) : (
            ''
          )}
        </div>

        <CoinWrapperSellLastBuyPrice
          symbolInfo={symbolInfo}
          sendWebSocket={sendWebSocket}></CoinWrapperSellLastBuyPrice>
      </div>
    );
  }
}
