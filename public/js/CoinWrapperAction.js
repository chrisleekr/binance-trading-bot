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


    const { coin_wrapper, common_strings } = jsonStrings;
    let label;
    switch (action) {
      case 'buy':
        label = common_strings._buy;
        break;
      case 'buy-temporary-disabled':
        label = coin_wrapper._actions.action_disabled;
        break;
      case 'buy-order-checking':
        label = coin_wrapper._actions.action_buy_check;
        break;
      case 'buy-order-filled':
        label = coin_wrapper._actions.action_buy_filled;
        break;
      case 'buy-order-wait':
        label = coin_wrapper._actions.action_buy_wait;
        break;
      case 'sell':
        label = common_strings._sell;
        break;
      case 'sell-temporary-disabled':
        label = coin_wrapper._actions.action_disabled;
        break;
      case 'sell-stop-loss':
        label = coin_wrapper._actions.action_selling_stop_loss;
        break;
      case 'sell-order-checking':
        label = coin_wrapper._actions.action_sell_check;
        break;
      case 'sell-order-wait':
        label = coin_wrapper._actions.action_sell_wait;
        break;
      case 'sell-wait':
        label = coin_wrapper._wait;
        break;
      default:
        label = coin_wrapper._wait;
    }

    if (isLocked) {
      label = common_strings._locked;
    }

    if (isActionDisabled.isDisabled) {
      label = coin_wrapper._actions.disabled_by + isActionDisabled.disabledBy;
    }

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='coin-info-label'>
            {common_strings._action} -{' '}
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
                {common_strings.time_remaining}){' '}
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
