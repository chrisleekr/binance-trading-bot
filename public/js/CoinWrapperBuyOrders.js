/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBuyOrders extends React.Component {
  render() {
    const {
      symbolInfo: {
        symbol,
        symbolInfo: {
          filterPrice: { tickSize }
        },
        buy: { openOrders }
      },
      sendWebSocket
    } = this.props;

    if (openOrders.length === 0) {
      return '';
    }

    const precision = parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

    const renderOpenOrders = openOrders.map((openOrder, index) => {
      return (
        <div
          key={'coin-wrapper-buy-orders-' + index}
          className='coin-info-sub-open-order-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <div className='coin-info-label d-flex flex-row'>
              <span>Open Order #{index + 1}</span>{' '}
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
                placed at {moment(openOrder.updatedAt).format('HH:mm:ss')}
              </HightlightChange>
            ) : (
              ''
            )}
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Status:</span>
            <HightlightChange className='coin-info-value'>
              {openOrder.status}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Type:</span>
            <HightlightChange className='coin-info-value'>
              {openOrder.type}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Qty:</span>
            <HightlightChange className='coin-info-value'>
              {parseFloat(openOrder.origQty).toFixed(precision)}
            </HightlightChange>
          </div>
          {openOrder.price > 0 ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Price:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.price).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.stopPrice > 0 ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Stop Price:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.stopPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>

          {openOrder.limitPrice ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Current limit Price:</span>
              <HightlightChange className='coin-info-value'>
                {parseFloat(openOrder.limitPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.differenceToCancel ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Difference to cancel:</span>
              <HightlightChange className='coin-info-value'>
                {openOrder.differenceToCancel.toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Current price:</span>
              <HightlightChange className='coin-info-value'>
                {openOrder.currentPrice.toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.differenceToExecute ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Difference to execute:</span>
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
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='coin-info-label'>Buy Open Orders</div>
        </div>
        {renderOpenOrders}
      </div>
    );
  }
}
