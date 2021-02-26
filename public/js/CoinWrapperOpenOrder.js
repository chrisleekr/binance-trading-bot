/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperOpenOrder extends React.Component {
  render() {
    const { symbolInfo } = this.props;

    if (symbolInfo.openOrder.type === null) {
      return null;
    }

    if (symbolInfo.openOrder.type) {
      return (
        <div className='coin-info-sub-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <span className='coin-info-label'>Open Order</span>
            {moment(symbolInfo.openOrder.updatedAt).isValid() ? (
              <HightlightChange
                className='coin-info-value'
                title={symbolInfo.openOrder.updatedAt}>
                {moment(symbolInfo.openOrder.updatedAt).format('HH:mm:ss')}
              </HightlightChange>
            ) : (
              ''
            )}
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Placed at:</span>
            <HightlightChange
              className='coin-info-value'
              title={symbolInfo.openOrder.createdAt}>
              {moment(symbolInfo.openOrder.createdAt).fromNow()}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Type:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.openOrder.type}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Side:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.openOrder.side}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-order'>
            <span className='coin-info-label'>Qty:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.openOrder.qty}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-price divider'></div>
          {symbolInfo.openOrder.lastBuyPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Last buy price:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.openOrder.lastBuyPrice.toFixed(
                  symbolInfo.precision
                )}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {symbolInfo.openOrder.currentPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Current price:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.openOrder.currentPrice.toFixed(
                  symbolInfo.precision
                )}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {symbolInfo.openOrder.minimumProfit ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Minimum profit:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.openOrder.minimumProfit.toFixed(0)}{' '}
                {symbolInfo.quoteAsset} (
                {symbolInfo.openOrder.minimumProfitPercentage.toFixed(2)}%)
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          {symbolInfo.openOrder.stopPrice ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Stop Price:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.openOrder.stopPrice.toFixed(symbolInfo.precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {symbolInfo.openOrder.limitPrice ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Limit Price:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.openOrder.limitPrice.toFixed(symbolInfo.precision)}
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          {symbolInfo.openOrder.difference ? (
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>Difference:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.openOrder.difference.toFixed(2)}%
              </HightlightChange>
            </div>
          ) : (
            ''
          )}
          <div className='coin-info-column coin-info-column-price divider'></div>
          <div className='coin-info-column coin-info-column-message'>
            <HightlightChange className='coin-info-message'>
              {symbolInfo.openOrder.processMessage}
            </HightlightChange>
          </div>
        </div>
      );
    }

    return (
      <div class='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <span className='coin-info-label'>Open Order</span>
          <span className='coin-info-value'></span>
        </div>
        <div className='coin-info-column coin-info-column-price'>
          <span className='coin-info-message'>N/A</span>
        </div>
      </div>
    );
  }
}
