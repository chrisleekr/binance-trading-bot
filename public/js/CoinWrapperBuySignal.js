/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBuySignal extends React.Component {
  render() {
    const {
      symbolInfo: {
        symbolInfo: {
          filterPrice: { tickSize }
        },
        symbolConfiguration,
        buy
      }
    } = this.props;

    if (buy.openOrders.length > 0) {
      return '';
    }

    const precision = tickSize.indexOf(1) - 1;

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <div className='coin-info-label'>
            Buy Signal{' '}
            <span className='coin-info-value'>
              {symbolConfiguration.buy.enabled ? (
                <i className='fa fa-toggle-on'></i>
              ) : (
                <i className='fa fa-toggle-off'></i>
              )}
            </span>
          </div>
          <HightlightChange
            className='coin-info-value'
            title={buy.updatedAt}
            id='buy-updated-at'>
            {moment(buy.updatedAt).format('HH:mm:ss')}
          </HightlightChange>
        </div>
        {symbolConfiguration.buy.enabled === false ? (
          <div className='coin-info-column coin-info-column-buy-enabled'>
            <HightlightChange className='coin-info-message text-muted'>
              Trading is disabled.
            </HightlightChange>
          </div>
        ) : (
          ''
        )}

        {buy.currentPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Current price:</span>
            <HightlightChange className='coin-info-value'>
              {(+buy.currentPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.lowestPrice ? (
          <div className='coin-info-column coin-info-column-lowest-price'>
            <span className='coin-info-label'>Lowest price:</span>
            <HightlightChange className='coin-info-value'>
              {(+buy.lowestPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        <div className='coin-info-column coin-info-column-price divider'></div>
        {buy.triggerPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>
              Trigger price (
              {((+symbolConfiguration.buy.triggerPercentage - 1) * 100).toFixed(
                2
              )}
              %):
            </span>
            <HightlightChange className='coin-info-value'>
              {(+buy.triggerPrice).toFixed(precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.difference ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Difference to buy:</span>
            <HightlightChange className='coin-info-value' id='buy-difference'>
              {(+buy.difference).toFixed(2)}%
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {buy.processMessage ? (
          <div>
            <div className='coin-info-column coin-info-column-price divider'></div>

            <div className='coin-info-column coin-info-column-message'>
              <HightlightChange className='coin-info-message'>
                {buy.processMessage}
              </HightlightChange>
            </div>
          </div>
        ) : (
          ''
        )}
      </div>
    );
  }
}
