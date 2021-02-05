/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSell extends React.Component {
  render() {
    const { symbolInfo } = this.props;

    if (symbolInfo.openOrder.type !== null) {
      return null;
    }

    if (symbolInfo.sell.lastBuyPrice) {
      return (
        <div className='coin-info-sub-wrapper'>
          <div className='coin-info-column coin-info-column-title'>
            <span className='coin-info-label'>Sell Signal</span>
            <HightlightChange
              className='coin-info-value'
              title={symbolInfo.sell.updatedAt}>
              {moment(symbolInfo.sell.updatedAt).format('HH:mm:ss')}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Last buy price:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.sell.lastBuyPrice.toFixed(4)}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Minimum selling price:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.sell.minimumSellingPrice.toFixed(4)}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Current price:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.sell.currentPrice.toFixed(4)}
            </HightlightChange>
          </div>
          <div className='coin-info-column coin-info-column-price'>
            <span className='coin-info-label'>Difference to sell:</span>
            <HightlightChange className='coin-info-value'>
              {symbolInfo.sell.difference.toFixed(2)}%
            </HightlightChange>
          </div>
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
