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

  objectDiff = (a, b) =>
    _.fromPairs(_.differenceWith(_.toPairs(a), _.toPairs(b), _.isEqual));

  render() {
    const { collapsed } = this.state;
    const {
      symbolInfo,
      configuration: globalConfiguration,
      symbolConfiguration: modalSymbolConfiguration,
      sendWebSocket
    } = this.props;
    const { configuration: symbolConfiguration } = symbolInfo;

    // Find out difference between global and symbol configuration. Using this to show overriden values.
    const diffConfiguration = _.pick(
      this.objectDiff(symbolConfiguration, globalConfiguration),
      ['candles', 'maxPurchaseAmount', 'stopLossLimit', 'buy', 'sell']
    );

    if (_.isEmpty(diffConfiguration)) {
      return (
        <div className='coin-info-sub-wrapper coin-info-sub-wrapper-setting'>
          <div className='coin-info-column coin-info-column-title coin-info-column-title-setting'>
            <div className='coin-info-label'>
              <div className='mr-1'>Setting - Global</div>
              <SymbolSettingIcon
                symbolInfo={symbolInfo}
                globalConfiguration={globalConfiguration}
                symbolConfiguration={modalSymbolConfiguration}
                sendWebSocket={sendWebSocket}
              />
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
            className={`coin-info-content-setting coin-info-column coin-info-column-message ${
              collapsed ? 'd-none' : ''
            }`}>
            This symbol is monitoring with global setting.
          </div>
        </div>
      );
    }
    return (
      <div className='coin-info-sub-wrapper coin-info-sub-wrapper-setting'>
        <div className='coin-info-column coin-info-column-title coin-info-column-title-setting'>
          <div className='coin-info-label'>
            <div className='mr-1'>
              Setting - <span class='coin-setting-customised'>Customised</span>
            </div>
            <SymbolSettingIcon
              symbolInfo={symbolInfo}
              globalConfiguration={globalConfiguration}
              symbolConfiguration={modalSymbolConfiguration}
              sendWebSocket={sendWebSocket}
            />
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
          {_.get(diffConfiguration, 'candles') ? (
            <div className='coin-info-sub-wrapper'>
              <span className='coin-info-sub-label'>Candles</span>
              {_.get(diffConfiguration, 'candles.interval') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Interval:</span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.candles.interval}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(diffConfiguration, 'candles.limit') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Limit:</span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.candles.limit}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}

          {_.get(diffConfiguration, 'maxPurchaseAmount') ||
          _.get(diffConfiguration, 'buy') ? (
            <div className='coin-info-sub-wrapper'>
              <span className='coin-info-sub-label'>Buy</span>
              {_.get(diffConfiguration, 'buy.enabled') !== undefined ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Trading enabled:</span>
                  <span className='coin-info-value'>
                    {diffConfiguration.buy.enabled ? (
                      <i className='fa fa-toggle-on'></i>
                    ) : (
                      <i className='fa fa-toggle-off'></i>
                    )}
                  </span>
                </div>
              ) : (
                ''
              )}

              {_.get(diffConfiguration, 'maxPurchaseAmount') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Maximum purchase amount:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.maxPurchaseAmount}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}

          {_.get(diffConfiguration, 'stopLossLimit') ||
          _.get(diffConfiguration, 'sell') ? (
            <div className='coin-info-sub-wrapper'>
              <span className='coin-info-sub-label'>Sell</span>
              {_.get(diffConfiguration, 'sell.enabled') !== undefined ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Trading enabled:</span>
                  <span className='coin-info-value'>
                    {diffConfiguration.sell.enabled ? (
                      <i className='fa fa-toggle-on'></i>
                    ) : (
                      <i className='fa fa-toggle-off'></i>
                    )}
                  </span>
                </div>
              ) : (
                ''
              )}
              {_.get(diffConfiguration, 'stopLossLimit.lastBuyPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Minimum profit percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.stopLossLimit.lastBuyPercentage}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(diffConfiguration, 'stopLossLimit.stopPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Stop price percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.stopLossLimit.stopPercentage}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(diffConfiguration, 'stopLossLimit.limitPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Limit price percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.stopLossLimit.limitPercentage}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}
        </div>
      </div>
    );
  }
}
