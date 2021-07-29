/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class CoinWrapperSetting extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      collapsed: true
    };

    this.toggleCollapse = this.toggleCollapse.bind(this);
  }

  toggleCollapse() {
    this.setState({
      collapsed: !this.state.collapsed
    });
  }

  render() {
    const { collapsed } = this.state;
    const {
      symbolInfo,
      jsonStrings: { coin_wrapper, common_strings }
    } = this.props;
    const { symbolConfiguration } = symbolInfo;

    const {
      quoteAssetBalance: { asset: quoteAsset }
    } = symbolInfo;

    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-setting'>
        <div className='coin-info-column coin-info-column-title coin-info-column-title-setting'>
          <div className='coin-info-label'>
            <div className='mr-1'>{common_strings._settings}</div>
          </div>

          <button
            type='button'
            className='btn btn-sm btn-link p-0 ml-1'
            onClick={this.toggleCollapse}>
            <i
              className={`fa ${
                collapsed ? 'fa-arrow-right' : 'fa-arrow-down'
              }`}></i>
          </button>
        </div>
        <div
          className={`coin-info-content-setting ${collapsed ? 'd-none' : ''}`}>
          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>{coin_wrapper._candles}</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings._interval}:
              </span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.candles.interval}
              </HightlightChange>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>{common_strings._limit}:</span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.candles.limit}
              </HightlightChange>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>{common_strings._buy}</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.trading_enabled}:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.buy.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.last_buy_price_remove_threshold}:
              </span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.buy.lastBuyPriceRemoveThreshold}{' '}
                {quoteAsset}
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.max_purchase_amount}:
              </span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.buy.maxPurchaseAmount} {quoteAsset}
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.trigger_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {(
                  (symbolConfiguration.buy.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.stop_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.buy.stopPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.limit_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.buy.limitPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>{common_strings._sell}</span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.trading_enabled}:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.trigger_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {(
                  (symbolConfiguration.sell.triggerPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.stop_price_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.sell.stopPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>

            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.limit_price_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {((symbolConfiguration.sell.limitPercentage - 1) * 100).toFixed(
                  2
                )}
                %
              </HightlightChange>
            </div>
          </div>

          <div className='coin-info-sub-wrapper'>
            <span className='coin-info-sub-label'>
              {common_strings._sell} - {common_strings.stop_loss}
            </span>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.stop_loss_enabled}:
              </span>
              <span className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.enabled ? (
                  <i className='fa fa-toggle-on'></i>
                ) : (
                  <i className='fa fa-toggle-off'></i>
                )}
              </span>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {common_strings.max_loss_percent}:
              </span>
              <HightlightChange className='coin-info-value'>
                {(
                  (symbolConfiguration.sell.stopLoss.maxLossPercentage - 1) *
                  100
                ).toFixed(2)}
                %
              </HightlightChange>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.temporary_disable_sell}:
              </span>
              <HightlightChange className='coin-info-value'>
                {moment
                  .duration(
                    symbolConfiguration.sell.stopLoss.disableBuyMinutes,
                    'minutes'
                  )
                  .humanize()}
              </HightlightChange>
            </div>
            <div className='coin-info-column coin-info-column-order'>
              <span className='coin-info-label'>
                {coin_wrapper.order_type}:
              </span>
              <HightlightChange className='coin-info-value'>
                {symbolConfiguration.sell.stopLoss.orderType}
              </HightlightChange>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
