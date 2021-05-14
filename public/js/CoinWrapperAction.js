/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperAction extends React.Component {
  render() {
    const {
      symbolInfo: { symbol, action, buy, isLocked, isActionDisabled },
      sendWebSocket
    } = this.props;

    let label;
    switch (action) {
      case 'buy':
        label = 'Buy';
        break;
      case 'buy-temporary-disabled':
        label = 'Temporary disabled';
        break;
      case 'buy-order-checking':
        label = 'Checking for buy order';
        break;
      case 'buy-order-wait':
        label = 'Wait for buy order';
        break;
      case 'sell':
        label = 'Sell';
        break;
      case 'sell-temporary-disabled':
        label = 'Temporary disabled';
        break;
      case 'sell-stop-loss':
        label = 'Selling due to stop-loss';
        break;
      case 'sell-order-checking':
        label = 'Checking for sell order';
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

    if (isLocked) {
      label = 'Locked';
    }

    if (isActionDisabled.isDisabled) {
      label = `Disabled by ${isActionDisabled.disabledBy}`;
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='coin-info-label'>
            Action -{' '}
            <span className='coin-info-value'>
              {moment(buy.updatedAt).format('HH:mm:ss')}
            </span>
            {isLocked === true ? <i className='ml-1 fa fa-lock'></i> : ''}
            {isActionDisabled.isDisabled === true ? (
              <i className='ml-1 fa fa-pause-circle text-warning'></i>
            ) : (
              ''
            )}
          </div>

          <div className='d-flex flex-column align-items-end'>
            <HightlightChange className='action-label'>
              {label}
            </HightlightChange>
            {isActionDisabled.isDisabled === true ? (
              <div className='ml-1'>
                {isActionDisabled.canResume === true ? (
                  <SymbolEnableActionIcon
                    symbol={symbol}
                    className='mr-1'
                    sendWebSocket={sendWebSocket}></SymbolEnableActionIcon>
                ) : (
                  ''
                )}
                ({moment.duration(isActionDisabled.ttl, 'seconds').humanize()}{' '}
                left){' '}
              </div>
            ) : (
              ''
            )}
          </div>
        </div>
      </div>
    );
  }
}
