/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBuy extends React.Component {
  render() {
    const { symbolInfo, symbolConfiguration } = this.props;

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
            title={symbolInfo.buy.updatedAt}
            id='buy-updated-at'>
            {moment(symbolInfo.buy.updatedAt).format('HH:mm:ss')}
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

        <div className='coin-info-column coin-info-column-buy-action'>
          <span className='coin-info-label'>Action:</span>
          <HightlightChange className='coin-info-value coin-info-value-hold'>
            {symbolInfo.buy.action}
          </HightlightChange>
        </div>
        {symbolInfo.buy.currentPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Current price:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.buy.currentPrice.toFixed(symbolInfo.precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {symbolInfo.buy.lowestPrice ? (
          <div className='coin-info-column coin-info-column-lowest-price'>
            <span className='coin-info-label'>Lowest price:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.buy.lowestPrice.toFixed(symbolInfo.precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        <div className='coin-info-column coin-info-column-price divider'></div>
        {symbolInfo.buy.triggerPrice ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>
              Trigger price (
              {((symbolConfiguration.buy.triggerPercentage - 1) * 100).toFixed(
                2
              )}
              %):
            </span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.buy.triggerPrice.toFixed(symbolInfo.precision)}
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {symbolInfo.buy.difference ? (
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Difference:</span>
            <HightlightChange className='coin-info-value' id='buy-difference'>
              {symbolInfo.buy.difference.toFixed(2)}%
            </HightlightChange>
          </div>
        ) : (
          ''
        )}
        {symbolInfo.buy.processMessage ? (
          <div>
            <div className='coin-info-column coin-info-column-price divider'></div>

            <div className='coin-info-column coin-info-column-message'>
              <HightlightChange className='coin-info-message'>
                {symbolInfo.buy.processMessage}
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
