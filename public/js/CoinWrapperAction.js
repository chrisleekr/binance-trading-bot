/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperAction extends React.Component {
  render() {
    const {
      symbolInfo: {
        symbol,
        action,
        buy,
        isLocked,
        isActionDisabled,
        overrideData
      },
      sendWebSocket,
      isAuthenticated
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

    let renderOverrideAction = '';
    if (_.isEmpty(overrideData) === false) {
      renderOverrideAction = (
        <div className='coin-info-column coin-info-column-title border-bottom-0 m-0 p-0'>
          <div
            className='w-100 px-1 text-warning'
            title={overrideData.actionAt}>
            Action <strong>{overrideData.action}</strong> will be executed{' '}
            {moment(overrideData.actionAt).fromNow()}, triggered by{' '}
            {overrideData.triggeredBy}.
          </div>
        </div>
      );
    }

    const updatedAt = moment
      .utc(buy.updatedAt, 'YYYY-MM-DDTHH:mm:ss.SSSSSS')
      .local();
    const currentTime = moment.utc().local();

    return (
      <div className='coin-info-sub-wrapper'>
        <div className='coin-info-column coin-info-column-title border-bottom-0 mb-0 pb-0'>
          <div className='coin-info-label'>
            Action -{' '}
            <HightlightChange className='coin-info-value' id='updated-at'>
              {updatedAt.format('HH:mm:ss')}
            </HightlightChange>
            {isLocked === true ? <i className='fas fa-lock ml-1'></i> : ''}
            {isActionDisabled.isDisabled === true ? (
              <i className='fas fa-pause-circle ml-1 text-warning'></i>
            ) : (
              ''
            )}
            {updatedAt.isBefore(currentTime, 'minute') ? (
              <OverlayTrigger
                trigger='click'
                key='action-updated-at-alert-overlay'
                placement='bottom'
                overlay={
                  <Popover id='action-updated-at-alert-overlay-right'>
                    <Popover.Content>
                      The bot didn't receive the price change for over a min. It
                      means the price hasn't changed in Binance. It will be
                      updated when the bot receives a new price change.
                      <br />
                      <br />
                      Last updated: {updatedAt.fromNow()}
                    </Popover.Content>
                  </Popover>
                }>
                <Button
                  variant='link'
                  className='p-0 m-0 ml-1 text-white-50 d-inline-block'
                  style={{ lineHeight: '17px' }}>
                  <i className='fas fa-exclamation-circle mx-1'></i>
                </Button>
              </OverlayTrigger>
            ) : (
              ''
            )}
          </div>

          <div className='d-flex flex-column align-items-end'>
            <HightlightChange
              className={`action-label ${
                label.length < 10 ? 'badge-pill badge-dark' : ''
              }`}>
              {label}
            </HightlightChange>
            {isActionDisabled.isDisabled === true ? (
              <div className='ml-1'>
                {isActionDisabled.canResume === true ? (
                  <SymbolEnableActionIcon
                    symbol={symbol}
                    className='mr-1'
                    sendWebSocket={sendWebSocket}
                    isAuthenticated={isAuthenticated}></SymbolEnableActionIcon>
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
        {renderOverrideAction}
      </div>
    );
  }
}
