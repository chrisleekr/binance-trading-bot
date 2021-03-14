/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperAction extends React.Component {
  render() {
    const { symbolInfo } = this.props;
    const { action } = symbolInfo;

    let label;
    switch (action) {
      case 'buy':
        label = 'Buy';
        break;
      case 'buy-order-wait':
        label = 'Wait for buy order';
        break;
      case 'sell':
        label = 'Sell';
        break;
      case 'sell-order-wait':
        label = 'Wait for sell order';
        break;
      case 'sell-wait':
        label = 'Wait';
        break;
      default:
        label = 'Wait';
    }
    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='coin-info-label'>Action</div>
          <HightlightChange className='action-label'>{label}</HightlightChange>
        </div>
      </div>
    );
  }
}
