/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBuyOrders extends React.Component {
  render() {
    const {
      symbolInfo: {
        symbolInfo: {
          filterPrice: { tickSize }
        },
        buy: { openOrders }
      }
    } = this.props;

    if (openOrders.length === 0) {
      return '';
    }

    const precision = tickSize.indexOf(1) - 1;

    const renderOpenOrders = openOrders.map((openOrder, index) => {
      return (
        <div key={index} className='coin-info-sub-open-order-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <span className='coin-info-label'>Open Order #{index + 1}</span>

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
              {(+openOrder.origQty).toFixed(precision)}
            </HightlightChange>
          </div>
          {openOrder.price > 0 ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'> Price:</span>
              <HightlightChange className='coin-info-value'>
                {(+openOrder.price).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.stopPrice > 0 ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Stop Price:</span>
              <HightlightChange className='coin-info-value'>
                {(+openOrder.stopPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Current price:</span>
            <HightlightChange className='coin-info-value'>
              {openOrder.currentPrice.toFixed(precision)}
            </HightlightChange>
          </div>
          {openOrder.limitPrice ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Current limit Price:</span>
              <HightlightChange className='coin-info-value'>
                {(+openOrder.limitPrice).toFixed(precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {openOrder.difference ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Difference to buy:</span>
              <HightlightChange className='coin-info-value'>
                {openOrder.difference.toFixed(2)}%
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
