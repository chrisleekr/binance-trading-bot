/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSell extends React.Component {
  render() {
    const { symbolInfo } = this.props;

    if (symbolInfo.openOrder.type !== null) {
      return null;
    }

    if (symbolInfo.sell.lastBuyPrice > 0) {
      return (
        <div className='coin-info-sub-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <span className='coin-info-label'>Sell Signal</span>
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
          {symbolInfo.sell.lastBuyPrice ? (
            <div className='coin-info-column coin-info-column-price'>
              <span className='coin-info-label'>Last buy price:</span>
              <HightlightChange className='coin-info-value'>
                {symbolInfo.sell.lastBuyPrice.toFixed(symbolInfo.precision)}
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
              <span className='coin-info-label'>Minimum selling price:</span>
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
      <div class='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <span className='coin-info-label'>Sell Signal</span>
          <span className='coin-info-value'></span>
        </div>
        <div className='coin-info-column coin-info-column-price'>
          <span className='coin-info-message'>N/A</span>
        </div>
      </div>
    );
  }
}
