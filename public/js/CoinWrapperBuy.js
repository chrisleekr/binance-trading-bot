/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBuy extends React.Component {
  render() {
    const { symbolInfo } = this.props;

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <span className='coin-info-label'>Buy Signal</span>
          <HightlightChange
            className='coin-info-value'
            title={symbolInfo.buy.updatedAt}
            id='buy-updated-at'>
            {moment(symbolInfo.buy.updatedAt).format('HH:mm:ss')}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-buy-action'>
          <span className='coin-info-label'>Action:</span>
          <HightlightChange className='coin-info-value coin-info-value-hold'>
            {symbolInfo.buy.action}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-price'>
          <span className='coin-info-label'>Current price:</span>
          <HightlightChange className='coin-info-value'>
            {symbolInfo.buy.currentPrice.toFixed(4)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-lowest-price'>
          <span className='coin-info-label'>Lowest price:</span>
          <HightlightChange className='coin-info-value'>
            {symbolInfo.buy.lowestPrice.toFixed(4)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-price'>
          <span className='coin-info-label'>Difference:</span>
          <HightlightChange className='coin-info-value' id='buy-difference'>
            {symbolInfo.buy.difference.toFixed(2)}%
          </HightlightChange>
        </div>
      </div>
    );
  }
}
