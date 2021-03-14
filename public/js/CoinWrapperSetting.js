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
      sendWebSocket
    } = this.props;
    const { symbolConfiguration } = symbolInfo;

    // Find out difference between global and symbol configuration. Using this to show overriden values.
    const diffConfiguration = _.pick(
      this.objectDiff(symbolConfiguration, globalConfiguration),
      ['candles', 'buy', 'sell']
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
              Setting -{' '}
              <span className='coin-setting-customised'>Customised</span>
            </div>
            <SymbolSettingIcon
              symbolInfo={symbolInfo}
              globalConfiguration={globalConfiguration}
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

          {_.get(diffConfiguration, 'buy') ? (
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

              {_.get(diffConfiguration, 'buy.maxPurchaseAmount') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Maximum purchase amount:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.buy.maxPurchaseAmount}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}

              {_.get(diffConfiguration, 'buy.triggerPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Trigger percentage:</span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.buy.triggerPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}

              {_.get(diffConfiguration, 'buy.stopPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Stop percentage:</span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.buy.stopPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}

              {_.get(diffConfiguration, 'buy.limitPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Limit percentage:</span>
                  <HightlightChange className='coin-info-value'>
                    {(
                      (symbolConfiguration.buy.limitPercentage - 1) *
                      100
                    ).toFixed(2)}
                    %
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}

          {_.get(diffConfiguration, 'sell') ? (
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
              {_.get(diffConfiguration, 'sell.triggerPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>Trigger percentage:</span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.sell.triggerPercentage}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(diffConfiguration, 'sell.stopPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Stop price percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.sell.stopPercentage}
                  </HightlightChange>
                </div>
              ) : (
                ''
              )}
              {_.get(diffConfiguration, 'sell.limitPercentage') ? (
                <div className='coin-info-column coin-info-column-order'>
                  <span className='coin-info-label'>
                    Limit price percentage:
                  </span>
                  <HightlightChange className='coin-info-value'>
                    {diffConfiguration.sell.limitPercentage}
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
