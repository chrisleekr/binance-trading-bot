/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperBalance extends React.Component {
  render() {
    const { symbolInfo } = this.props;

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title'>
          <span className='coin-info-label'>Balance</span>
          <span className='coin-info-value'>{symbolInfo.baseAsset}</span>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>Free:</span>
          <HightlightChange className='coin-info-value'>
            {symbolInfo.balance.free.toFixed(symbolInfo.precision)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>Locked:</span>
          <HightlightChange className='coin-info-value'>
            {symbolInfo.balance.locked.toFixed(symbolInfo.precision)}
          </HightlightChange>
        </div>
        <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
          <span className='coin-info-label'>Estimated Value:</span>
          <HightlightChange className='coin-info-value'>
            {symbolInfo.balance.estimatedValue.toFixed(2)}{' '}
            {symbolInfo.quoteAsset}
          </HightlightChange>
        </div>
      </div>
    );
  }
}
