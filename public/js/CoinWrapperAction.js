/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperAction extends React.Component {
  render() {
    const {
      symbolInfo: { symbol, action, buy, isLocked, isActionDisabled },
      sendWebSocket,
      jsonStrings
    } = this.props;


    const { coinWrapper, commonStrings } = jsonStrings;
    let label;
    switch (action) {
      case 'buy':
        label = commonStrings.buy;
        break;
      case 'buy-temporary-disabled':
        label = coinWrapper.actions.action_disabled;
        break;
      case 'buy-order-checking':
        label = coinWrapper.actions.action_buy_check;
        break;
      case 'buy-order-filled':
        label = coinWrapper.actions.action_buy_filled;
        break;
      case 'buy-order-wait':
        label = coinWrapper.actions.action_buy_wait;
        break;
      case 'sell':
        label = commonStrings.sell;
        break;
      case 'sell-temporary-disabled':
        label = coinWrapper.actions.action_disabled;
        break;
      case 'sell-stop-loss':
        label = coinWrapper.actions.action_selling_stop_loss;
        break;
      case 'sell-order-checking':
        label = coinWrapper.actions.action_sell_check;
        break;
      case 'sell-order-wait':
        label = coinWrapper.actions.action_sell_wait;
        break;
      case 'sell-wait':
        label = coinWrapper.wait;
        break;
      default:
        label = coinWrapper.wait;
    }

    if (isLocked) {
      label = commonStrings.locked;
    }

    if (isActionDisabled.isDisabled) {
      label = coinWrapper.actions.disabled_by + isActionDisabled.disabledBy;
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='coin-info-label'>
            {commonStrings.action} -{' '}
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
                    sendWebSocket={sendWebSocket}
                    jsonStrings={jsonStrings}></SymbolEnableActionIcon>
                ) : (
                  ''
                )}
                ({moment.duration(isActionDisabled.ttl, 'seconds').humanize()}{' '}
                {commonStrings.time_remaining}){' '}
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
