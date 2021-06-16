/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSellOrders extends React.Component {
  render() {
    const { symbolInfo, sendWebSocket, jsonStrings } = this.props;

    const {
      symbolInfo: {
        symbol,
        filterPrice: { tickSize }
      },
      symbolConfiguration,
      sell: { openOrders },
      quoteAssetBalance: { asset: quoteAsset }
    } = symbolInfo;

    if (openOrders.length === 0 || _.isEmpty(jsonStrings)) {
      return '';
    }

    const { coinWrapper, commonStrings } = jsonStrings;

    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    const renderOpenOrders = openOrders.map((openOrder, index) => {
      return (
        <div
          key={'coin-wrapper-sell-order-' + index}
          className='coin-info-sub-open-order-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <div className='coin-info-label d-flex flex-row'>
              <span>{coinWrapper.open_order} #{index + 1}</span>{' '}
              <SymbolCancelIcon
                symbol={symbol}
                order={openOrder}
                sendWebSocket={sendWebSocket}
              />
            </div>

            {openOrder.updatedAt && moment(openOrder.updatedAt).isValid() ? (
              <HightlightChange
                className='coin-info-value'
                title={openOrder.updatedAt}>
                {coinWrapper.placed_at} {moment(openOrder.updatedAt).format('HH:mm:ss')}
              </HightlightChange>
            ) : (
              ''
            )}
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>{commonStrings.status}:</span>
            <HightlightChange className='coin-info-value'>
              {openOrder.status}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>{coinWrapper.type}:</span>
            <HightlightChange className='coin-info-value'>
              {openOrder.type}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>{commonStrings.quantity}:</span>
            <HightlightChange className='coin-info-value'>
              {parseFloat(openOrder.origQty).toFixed(precision)}
            </HightlightChange>
          </div>
          {openOrder.price > 0 ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>{commonStrings.price}:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.price).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.stopPrice > 0 ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>{commonStrings.stop_price}:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.stopPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>

          {openOrder.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>{commonStrings.current_price}:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.currentPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.minimumProfit ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>{coinWrapper.minimum_profit}:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.minimumProfit).toFixed(precision)}{' '}
                {quoteAsset} (
                {parseFloat(openOrder.minimumProfitPercentage).toFixed(2)}%)
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          {openOrder.limitPrice ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>{coinWrapper.current_limit_price}:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.limitPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.differenceToCancel ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>{coinWrapper.diff_cancel}:</span>
              <HightlightChange className='coin-info-value'>
                {openOrder.differenceToCancel.toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>{commonStrings.current_price}:</span>
              <HightlightChange className='coin-info-value'>
                {openOrder.currentPrice.toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.differenceToExecute ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>{coinWrapper.diff_execute}:</span>
              <HightlightChange className='coin-info-value'>
                {openOrder.differenceToExecute.toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
        </div>
      );
    });

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <div className='coin-info-label'>
            {coinWrapper.sell_open_orders}{' '}
            <span className='coin-info-value'>
              {symbolConfiguration.sell.enabled ? (
                <i className='fa fa-toggle-on'></i>
              ) : (
                <i className='fa fa-toggle-off'></i>
              )}
            </span>
          </div>
        </div>
        <CoinWrapperSellLastBuyPrice
          symbolInfo={symbolInfo}
          sendWebSocket={sendWebSocket}
          jsonStrings={jsonStrings}></CoinWrapperSellLastBuyPrice>
        {renderOpenOrders}
      </div>
    );
  }
}
