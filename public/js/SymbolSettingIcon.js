/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      setting: 'showSettingModal',
      confirm: 'showConfirmModal',
      gridTrade: 'showResetGridTradeModal'
    };

    this.state = {
      showSettingModal: false,
      showConfirmModal: false,
      showResetGridTradeModal: false,
      symbolConfiguration: {},
      validation: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);

    this.handleInputChange = this.handleInputChange.bind(this);
    this.resetToGlobalConfiguration =
      this.resetToGlobalConfiguration.bind(this);
    this.handleGridTradeChange = this.handleGridTradeChange.bind(this);
    this.handleBotOptionsChange = this.handleBotOptionsChange.bind(this);

    this.handleSetValidation = this.handleSetValidation.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update symbol configuration, when the modal is closed and different.
    if (
      this.state.showSettingModal === false &&
      _.get(nextProps, 'symbolInfo.symbolConfiguration', null) !== null &&
      _.isEqual(
        _.get(nextProps, 'symbolInfo.symbolConfiguration', null),
        this.state.symbolConfiguration
      ) === false
    ) {
      this.setState({
        symbolConfiguration: nextProps.symbolInfo.symbolConfiguration
      });
    }
  }

  handleFormSubmit(e) {
    e.preventDefault();

    this.handleModalClose('setting');

    // Send with symbolInfo
    const { symbolInfo } = this.props;
    const newSymbolInfo = symbolInfo;
    newSymbolInfo.configuration = this.state.symbolConfiguration;

    this.props.sendWebSocket('symbol-setting-update', newSymbolInfo);
  }

  handleModalShow(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: true
    });
  }

  handleModalClose(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: false
    });
  }

  handleInputChange(event) {
    const target = event.target;
    const value =
      target.type === 'checkbox'
        ? target.checked
        : target.type === 'number'
        ? +target.value
        : target.value;
    const stateKey = target.getAttribute('data-state-key');

    const { symbolConfiguration } = this.state;

    this.setState({
      symbolConfiguration: _.set(symbolConfiguration, stateKey, value)
    });
  }

  resetToGlobalConfiguration() {
    const { symbolInfo } = this.props;

    this.handleModalClose('confirm');
    this.handleModalClose('setting');
    this.handleModalClose('gridTrade');
    this.props.sendWebSocket('symbol-setting-delete', symbolInfo);
  }

  resetGridTrade(action) {
    const { symbolInfo } = this.props;

    this.handleModalClose('confirm');
    this.handleModalClose('setting');
    this.handleModalClose('gridTrade');
    this.props.sendWebSocket('symbol-grid-trade-delete', {
      action,
      symbol: symbolInfo.symbol
    });
  }

  handleGridTradeChange(type, newGrid) {
    const { symbolConfiguration } = this.state;

    this.setState({
      symbolConfiguration: _.set(
        symbolConfiguration,
        `${type}.gridTrade`,
        newGrid
      )
    });
  }

  handleBotOptionsChange(newBotOptions) {
    const { symbolConfiguration } = this.state;

    this.setState({
      symbolConfiguration: _.set(
        symbolConfiguration,
        'botOptions',
        newBotOptions
      )
    });
  }

  handleSetValidation(type, isValid) {
    const { validation } = this.state;
    this.setState({ validation: { ...validation, [type]: isValid } });
  }

  render() {
    const { symbolInfo, isAuthenticated } = this.props;
    const { symbolConfiguration } = this.state;

    if (_.isEmpty(symbolConfiguration) || isAuthenticated === false) {
      return '';
    }

    const {
      symbolInfo: { quoteAsset, filterMinNotional }
    } = symbolInfo;
    const minNotional = parseFloat(filterMinNotional.minNotional);

    return (
      <div className='symbol-setting-icon-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0'
          onClick={() => this.handleModalShow('setting')}>
          <i className='fas fa-cog'></i>
        </button>
        <Modal
          show={this.state.showSettingModal}
          onHide={() => this.handleModalClose('setting')}
          size='xl'>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>Customise {symbolInfo.symbol} Settings</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <span className='text-muted'>
                In this modal, you can override the global configuration for a
                specific symbol. Please make sure you understand what the
                setting is about before changing the configuration value. Note
                that these are symbol specific settings, which means only this
                symbol will be applied to settings.
              </span>

              <Accordion defaultActiveKey='0'>
                <Card className='mt-1'>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      Candle Settings
                    </Accordion.Toggle>
                  </Card.Header>
                  <Accordion.Collapse eventKey='0'>
                    <Card.Body className='px-2 py-1'>
                      <div className='row'>
                        <div className='col-6'>
                          <Form.Group
                            controlId='field-candles-interval'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Interval
                              <OverlayTrigger
                                trigger='click'
                                key='interval-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='interval-overlay-right'>
                                    <Popover.Content>
                                      Set candle interval for calculating the
                                      highest/lowest price.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fas fa-question-circle fa-sm'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              as='select'
                              required
                              data-state-key='candles.interval'
                              value={symbolConfiguration.candles.interval}
                              onChange={this.handleInputChange}>
                              <option value='1m'>1m</option>
                              <option value='3m'>3m</option>
                              <option value='5m'>5m</option>
                              <option value='15m'>15m</option>
                              <option value='30m'>30m</option>
                              <option value='1h'>1h</option>
                              <option value='2h'>2h</option>
                              <option value='4h'>4h</option>
                              <option value='1d'>1d</option>
                            </Form.Control>
                          </Form.Group>
                        </div>
                        <div className='col-6'>
                          <Form.Group
                            controlId='field-candles-limit'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Limit{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='limit-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='limit-overlay-right'>
                                    <Popover.Content>
                                      Set the number of candles to retrieve for
                                      calculating the highest/lowest price.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fas fa-question-circle fa-sm'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter limit'
                              required
                              min='0'
                              step='1'
                              data-state-key='candles.limit'
                              value={symbolConfiguration.candles.limit}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
                        </div>
                      </div>
                    </Card.Body>
                  </Accordion.Collapse>
                </Card>
              </Accordion>

              <Accordion defaultActiveKey='0'>
                <Card className='mt-1'>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      Buy Configurations
                    </Accordion.Toggle>
                  </Card.Header>
                  <Accordion.Collapse eventKey='0'>
                    <Card.Body className='px-2 py-1'>
                      <div className='row'>
                        <div className='col-12'>
                          <Form.Group
                            controlId='field-buy-enabled'
                            className='mb-2'>
                            <Form.Check size='sm'>
                              <Form.Check.Input
                                type='checkbox'
                                data-state-key='buy.enabled'
                                checked={symbolConfiguration.buy.enabled}
                                onChange={this.handleInputChange}
                              />
                              <Form.Check.Label>
                                Trading Enabled{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='buy-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='buy-enabled-overlay-right'>
                                      <Popover.Content>
                                        If enabled, the bot will purchase the
                                        coin when it detects the buy signal. If
                                        disabled, the bot will not purchase the
                                        coin, but continue to monitoring. When
                                        the market is volatile, you can disable
                                        it temporarily.
                                      </Popover.Content>
                                    </Popover>
                                  }>
                                  <Button
                                    variant='link'
                                    className='p-0 m-0 ml-1 text-info'>
                                    <i className='fas fa-question-circle fa-sm'></i>
                                  </Button>
                                </OverlayTrigger>
                              </Form.Check.Label>
                            </Form.Check>
                          </Form.Group>
                        </div>

                        <div className='col-12'>
                          <SymbolSettingIconGridBuy
                            gridTrade={symbolConfiguration.buy.gridTrade}
                            quoteAsset={quoteAsset}
                            minNotional={minNotional}
                            handleSetValidation={this.handleSetValidation}
                            handleGridTradeChange={this.handleGridTradeChange}
                          />
                        </div>
                        <div className='col-12'>
                          <Accordion defaultActiveKey='0'>
                            <Card className='mt-1'>
                              <Card.Header className='px-2 py-1'>
                                <Accordion.Toggle
                                  as={Button}
                                  variant='link'
                                  eventKey='0'
                                  className='p-0 fs-7 text-uppercase'>
                                  Last buy price removal threshold
                                </Accordion.Toggle>
                              </Card.Header>
                              <Accordion.Collapse eventKey='0'>
                                <Card.Body className='px-2 py-1'>
                                  <Form.Group
                                    controlId='field-last-buy-remove-threshold'
                                    className='mb-2'>
                                    <Form.Label className='mb-0'>
                                      Remove last buy price when the estimated
                                      value is lower than{' '}
                                      <OverlayTrigger
                                        trigger='click'
                                        key='last-buy-remove-threshold-overlay'
                                        placement='bottom'
                                        overlay={
                                          <Popover id='last-buy-remove-threshold-overlay-right'>
                                            <Popover.Content>
                                              Set the last buy price removal
                                              threshold. When the estimated
                                              value drops below the threshold,
                                              the bot will remove the last buy
                                              price.
                                            </Popover.Content>
                                          </Popover>
                                        }>
                                        <Button
                                          variant='link'
                                          className='p-0 m-0 ml-1 text-info'>
                                          <i className='fas fa-question-circle fa-sm'></i>
                                        </Button>
                                      </OverlayTrigger>
                                    </Form.Label>
                                    <Form.Control
                                      size='sm'
                                      type='number'
                                      placeholder='Enter last buy threshold'
                                      required
                                      min='0.00000001'
                                      step='0.00000001'
                                      data-state-key='buy.lastBuyPriceRemoveThreshold'
                                      value={
                                        symbolConfiguration.buy
                                          .lastBuyPriceRemoveThreshold
                                      }
                                      onChange={this.handleInputChange}
                                    />
                                  </Form.Group>
                                </Card.Body>
                              </Accordion.Collapse>
                            </Card>
                          </Accordion>
                        </div>
                      </div>

                      <Accordion defaultActiveKey='0'>
                        <Card className='mt-1'>
                          <Card.Header className='px-2 py-1'>
                            <Accordion.Toggle
                              as={Button}
                              variant='link'
                              eventKey='0'
                              className='p-0 fs-7 text-uppercase'>
                              Buy Restriction with ATH (All Time High)
                            </Accordion.Toggle>
                          </Card.Header>
                          <Accordion.Collapse eventKey='0'>
                            <Card.Body className='px-2 py-1'>
                              <div className='row'>
                                <div className='col-12'>
                                  <Form.Group
                                    controlId='field-buy-ath-restriction-enabled'
                                    className='mb-2'>
                                    <Form.Check size='sm'>
                                      <Form.Check.Input
                                        type='checkbox'
                                        data-state-key='buy.athRestriction.enabled'
                                        checked={
                                          symbolConfiguration.buy.athRestriction
                                            .enabled
                                        }
                                        onChange={this.handleInputChange}
                                      />
                                      <Form.Check.Label>
                                        ATH Buy Restriction Enabled{' '}
                                        <OverlayTrigger
                                          trigger='click'
                                          key='buy-ath-restriction-enabled-overlay'
                                          placement='bottom'
                                          overlay={
                                            <Popover id='buy-ath-restriction-enabled-overlay-right'>
                                              <Popover.Content>
                                                If enabled, the bot will
                                                retrieve ATH (All Time High)
                                                price of the coin based on the
                                                interval/candle configuration.
                                                If the buy trigger price is
                                                higher than ATH buy restriction
                                                price, which is calculated by
                                                ATH Restriction price
                                                percentage, the bot will not
                                                place a buy order. The bot will
                                                place an order when the trigger
                                                price is lower than ATH buy
                                                restriction price.
                                              </Popover.Content>
                                            </Popover>
                                          }>
                                          <Button
                                            variant='link'
                                            className='p-0 m-0 ml-1 text-info'>
                                            <i className='fas fa-question-circle fa-sm'></i>
                                          </Button>
                                        </OverlayTrigger>
                                      </Form.Check.Label>
                                    </Form.Check>
                                  </Form.Group>
                                </div>

                                <div className='col-xs-12 col-sm-6'>
                                  <Form.Group
                                    controlId='field-ath-candles-interval'
                                    className='mb-2'>
                                    <Form.Label className='mb-0'>
                                      Interval
                                      <OverlayTrigger
                                        trigger='click'
                                        key='interval-overlay'
                                        placement='bottom'
                                        overlay={
                                          <Popover id='interval-overlay-right'>
                                            <Popover.Content>
                                              Set candle interval for
                                              calculating the ATH (All The High)
                                              price.
                                            </Popover.Content>
                                          </Popover>
                                        }>
                                        <Button
                                          variant='link'
                                          className='p-0 m-0 ml-1 text-info'>
                                          <i className='fas fa-question-circle fa-sm'></i>
                                        </Button>
                                      </OverlayTrigger>
                                    </Form.Label>
                                    <Form.Control
                                      size='sm'
                                      as='select'
                                      required
                                      data-state-key='buy.athRestriction.candles.interval'
                                      value={
                                        symbolConfiguration.buy.athRestriction
                                          .candles.interval
                                      }
                                      onChange={this.handleInputChange}>
                                      <option value='1m'>1m</option>
                                      <option value='3m'>3m</option>
                                      <option value='5m'>5m</option>
                                      <option value='15m'>15m</option>
                                      <option value='30m'>30m</option>
                                      <option value='1h'>1h</option>
                                      <option value='2h'>2h</option>
                                      <option value='4h'>4h</option>
                                      <option value='1d'>1d</option>
                                    </Form.Control>
                                  </Form.Group>
                                </div>
                                <div className='col-xs-12 col-sm-6'>
                                  <Form.Group
                                    controlId='field-ath-candles-limit'
                                    className='mb-2'>
                                    <Form.Label className='mb-0'>
                                      Limit
                                      <OverlayTrigger
                                        trigger='click'
                                        key='limit-overlay'
                                        placement='bottom'
                                        overlay={
                                          <Popover id='limit-overlay-right'>
                                            <Popover.Content>
                                              Set the number of candles to
                                              retrieve for calculating the ATH
                                              (All The High) price.
                                            </Popover.Content>
                                          </Popover>
                                        }>
                                        <Button
                                          variant='link'
                                          className='p-0 m-0 ml-1 text-info'>
                                          <i className='fas fa-question-circle fa-sm'></i>
                                        </Button>
                                      </OverlayTrigger>
                                    </Form.Label>
                                    <Form.Control
                                      size='sm'
                                      type='number'
                                      placeholder='Enter limit'
                                      required
                                      min='0'
                                      step='1'
                                      data-state-key='buy.athRestriction.candles.limit'
                                      value={
                                        symbolConfiguration.buy.athRestriction
                                          .candles.limit
                                      }
                                      onChange={this.handleInputChange}
                                    />
                                  </Form.Group>
                                </div>
                                <div className='col-xs-12 col-sm-6'>
                                  <Form.Group
                                    controlId='field-buy-restriction-percentage'
                                    className='mb-2'>
                                    <Form.Label className='mb-0'>
                                      Restriction price percentage{' '}
                                      <OverlayTrigger
                                        trigger='click'
                                        key='interval-overlay'
                                        placement='bottom'
                                        overlay={
                                          <Popover id='interval-overlay-right'>
                                            <Popover.Content>
                                              Set the percentage to calculate
                                              restriction price. i.e. if set{' '}
                                              <code>0.9</code> and the ATH(All
                                              Time High) price <code>$110</code>
                                              , restriction price will be{' '}
                                              <code>$99</code> for stop limit
                                              order.
                                            </Popover.Content>
                                          </Popover>
                                        }>
                                        <Button
                                          variant='link'
                                          className='p-0 m-0 ml-1 text-info'>
                                          <i className='fas fa-question-circle fa-sm'></i>
                                        </Button>
                                      </OverlayTrigger>
                                    </Form.Label>
                                    <Form.Control
                                      size='sm'
                                      type='number'
                                      placeholder='Enter restriction price percentage'
                                      required
                                      min='0'
                                      step='0.0001'
                                      data-state-key='buy.athRestriction.restrictionPercentage'
                                      value={
                                        symbolConfiguration.buy.athRestriction
                                          .restrictionPercentage
                                      }
                                      onChange={this.handleInputChange}
                                    />
                                  </Form.Group>
                                </div>
                              </div>
                            </Card.Body>
                          </Accordion.Collapse>
                        </Card>
                      </Accordion>

                      <Accordion defaultActiveKey='0'>
                        <Card className='mt-1'>
                          <Card.Header className='px-2 py-1'>
                            <Accordion.Toggle
                              as={Button}
                              variant='link'
                              eventKey='0'
                              className='p-0 fs-7 text-uppercase'>
                              TradingView{' '}
                            </Accordion.Toggle>
                          </Card.Header>
                          <Accordion.Collapse eventKey='0'>
                            <Card.Body className='px-2 py-1'>
                              <div className='row'>
                                <div className='col-12'>
                                  What is{' '}
                                  <a
                                    href='https://www.tradingview.com/symbols/BTCUSDT/technicals/'
                                    target='_blank'
                                    rel='noreferrer'>
                                    TradingView
                                  </a>
                                  ?{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='bot-options-auto-trigger-buy-conditions-tradingview-when-strong-buy-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='bot-options-auto-trigger-buy-conditions-tradingview-when-strong-buy-overlay-right'>
                                        <Popover.Content>
                                          TradingView is the service that
                                          provides technical analysis based on
                                          various indicators such as oscillators
                                          and moving averages. The bot is
                                          integrated with TradingView summary
                                          recommendation to control the buy
                                          action.
                                        </Popover.Content>
                                      </Popover>
                                    }>
                                    <Button
                                      variant='link'
                                      className='p-0 m-0 ml-1 text-info'>
                                      <i className='fas fa-question-circle fa-sm'></i>
                                    </Button>
                                  </OverlayTrigger>
                                </div>
                                <div className='col-12'>
                                  <Form.Group
                                    controlId='field-buy-tradingview-when-strong-buy'
                                    className='mb-2'>
                                    <Form.Check size='sm'>
                                      <Form.Check.Input
                                        type='checkbox'
                                        data-state-key='buy.tradingView.whenStrongBuy'
                                        checked={
                                          symbolConfiguration.buy.tradingView
                                            .whenStrongBuy
                                        }
                                        onChange={this.handleInputChange}
                                      />
                                      <Form.Check.Label>
                                        Allow buy trigger when recommendation is{' '}
                                        <code>Strong buy</code>{' '}
                                        <OverlayTrigger
                                          trigger='click'
                                          key='buy-tradingview-when-strong-buy-overlay'
                                          placement='bottom'
                                          overlay={
                                            <Popover id='buy-tradingview-when-strong-buy-overlay-right'>
                                              <Popover.Content>
                                                If enabled, the bot will use
                                                TradingView recommendation to
                                                trigger the buy. If the buy
                                                trigger price is reached, the
                                                bot will check TradingView
                                                recommendation and if it is not
                                                `Strong buy`, then the bot will
                                                not place a buy order.
                                              </Popover.Content>
                                            </Popover>
                                          }>
                                          <Button
                                            variant='link'
                                            className='p-0 m-0 ml-1 text-info'>
                                            <i className='fas fa-question-circle fa-sm'></i>
                                          </Button>
                                        </OverlayTrigger>
                                      </Form.Check.Label>
                                    </Form.Check>
                                  </Form.Group>
                                </div>
                                <div className='col-12'>
                                  <Form.Group
                                    controlId='field-buy-tradingview-when-buy'
                                    className='mb-2'>
                                    <Form.Check size='sm'>
                                      <Form.Check.Input
                                        type='checkbox'
                                        data-state-key='buy.tradingView.whenBuy'
                                        checked={
                                          symbolConfiguration.buy.tradingView
                                            .whenBuy
                                        }
                                        onChange={this.handleInputChange}
                                      />
                                      <Form.Check.Label>
                                        Allow buy trigger when recommendation is{' '}
                                        <code>Buy</code>{' '}
                                        <OverlayTrigger
                                          trigger='click'
                                          key='buy-tradingview-when-buy-overlay'
                                          placement='bottom'
                                          overlay={
                                            <Popover id='buy-tradingview-when-buy-overlay-right'>
                                              <Popover.Content>
                                                If enabled, the bot will use
                                                TradingView recommendation to
                                                trigger the buy. If the buy
                                                trigger price is reached, the
                                                bot will check TradingView
                                                recommendation and if it is not
                                                `Buy`, then the bot will not
                                                place a buy order.
                                              </Popover.Content>
                                            </Popover>
                                          }>
                                          <Button
                                            variant='link'
                                            className='p-0 m-0 ml-1 text-info'>
                                            <i className='fas fa-question-circle fa-sm'></i>
                                          </Button>
                                        </OverlayTrigger>
                                      </Form.Check.Label>
                                    </Form.Check>
                                  </Form.Group>
                                </div>
                              </div>
                            </Card.Body>
                          </Accordion.Collapse>
                        </Card>
                      </Accordion>
                    </Card.Body>
                  </Accordion.Collapse>
                </Card>
              </Accordion>

              <Accordion defaultActiveKey='0'>
                <Card className='mt-1'>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      Sell Configurations
                    </Accordion.Toggle>
                  </Card.Header>
                  <Accordion.Collapse eventKey='0'>
                    <Card.Body className='px-2 py-1'>
                      <div className='row'>
                        <div className='col-12'>
                          <Form.Group
                            controlId='field-sell-enabled'
                            className='mb-2'>
                            <Form.Check size='sm'>
                              <Form.Check.Input
                                type='checkbox'
                                data-state-key='sell.enabled'
                                checked={symbolConfiguration.sell.enabled}
                                onChange={this.handleInputChange}
                              />
                              <Form.Check.Label>
                                Trading Enabled{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='buy-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='buy-enabled-overlay-right'>
                                      <Popover.Content>
                                        If enabled, the bot will sell the coin
                                        when it detects the sell signal. If
                                        disabled, the bot will not sell the
                                        coin, but continue to monitoring. When
                                        the market is volatile, you can disable
                                        it temporarily.
                                      </Popover.Content>
                                    </Popover>
                                  }>
                                  <Button
                                    variant='link'
                                    className='p-0 m-0 ml-1 text-info'>
                                    <i className='fas fa-question-circle fa-sm'></i>
                                  </Button>
                                </OverlayTrigger>
                              </Form.Check.Label>
                            </Form.Check>
                          </Form.Group>
                        </div>
                        <div className='col-12'>
                          <SymbolSettingIconGridSell
                            gridTrade={symbolConfiguration.sell.gridTrade}
                            quoteAsset={quoteAsset}
                            handleSetValidation={this.handleSetValidation}
                            handleGridTradeChange={this.handleGridTradeChange}
                          />
                        </div>
                        <div className='col-12'>
                          <Accordion defaultActiveKey='0'>
                            <Card className='mt-1'>
                              <Card.Header className='px-2 py-1'>
                                <Accordion.Toggle
                                  as={Button}
                                  variant='link'
                                  eventKey='0'
                                  className='p-0 fs-7 text-uppercase'>
                                  Sell Stop-Loss
                                </Accordion.Toggle>
                              </Card.Header>
                              <Accordion.Collapse eventKey='0'>
                                <Card.Body className='px-2 py-1'>
                                  <div className='row'>
                                    <div className='col-12'>
                                      <Form.Group
                                        controlId='field-sell-stop-loss-enabled'
                                        className='mb-2'>
                                        <Form.Check size='sm'>
                                          <Form.Check.Input
                                            type='checkbox'
                                            data-state-key='sell.stopLoss.enabled'
                                            checked={
                                              symbolConfiguration.sell.stopLoss
                                                .enabled
                                            }
                                            onChange={this.handleInputChange}
                                          />
                                          <Form.Check.Label>
                                            Stop-Loss Enabled{' '}
                                            <OverlayTrigger
                                              trigger='click'
                                              key='sell-stop-loss-enabled-overlay'
                                              placement='bottom'
                                              overlay={
                                                <Popover id='sell-stop-loss-enabled-overlay-right'>
                                                  <Popover.Content>
                                                    If enabled, the bot will
                                                    sell the coin when it
                                                    reaches the configured
                                                    amount of the loss from the
                                                    last buy price. You can
                                                    enable this feature to
                                                    prevent the loss more than
                                                    expected.
                                                  </Popover.Content>
                                                </Popover>
                                              }>
                                              <Button
                                                variant='link'
                                                className='p-0 m-0 ml-1 text-info'>
                                                <i className='fas fa-question-circle fa-sm'></i>
                                              </Button>
                                            </OverlayTrigger>
                                          </Form.Check.Label>
                                        </Form.Check>
                                      </Form.Group>
                                    </div>
                                    <div className='col-xs-12 col-sm-6'>
                                      <Form.Group
                                        controlId='field-sell-stop-loss-max-loss-percentage'
                                        className='mb-2'>
                                        <Form.Label className='mb-0'>
                                          Max loss percentage{' '}
                                          <OverlayTrigger
                                            trigger='click'
                                            key='sell-stop-loss-max-loss-percentage-overlay'
                                            placement='bottom'
                                            overlay={
                                              <Popover id='sell-stop-loss-max-loss-percentage-overlay-right'>
                                                <Popover.Content>
                                                  Set maximum loss percentage
                                                  for stop-loss. i.e. if set{' '}
                                                  <code>0.80</code>, it means
                                                  you won't lose than{' '}
                                                  <code>-20%</code> of the last
                                                  buy price. When you purchased
                                                  the coin at <code>$100</code>,
                                                  the last price will be set as{' '}
                                                  <code>$100</code>. And then
                                                  when the current price reaches{' '}
                                                  <code>$80</code>, the bot will
                                                  place the{' '}
                                                  <strong>market order</strong>{' '}
                                                  to sell all available balance.
                                                </Popover.Content>
                                              </Popover>
                                            }>
                                            <Button
                                              variant='link'
                                              className='p-0 m-0 ml-1 text-info'>
                                              <i className='fas fa-question-circle fa-sm'></i>
                                            </Button>
                                          </OverlayTrigger>
                                        </Form.Label>
                                        <Form.Control
                                          size='sm'
                                          type='number'
                                          placeholder='Enter maximum loss percentage'
                                          required
                                          max='1'
                                          min='0'
                                          step='0.0001'
                                          data-state-key='sell.stopLoss.maxLossPercentage'
                                          value={
                                            symbolConfiguration.sell.stopLoss
                                              .maxLossPercentage
                                          }
                                          onChange={this.handleInputChange}
                                        />
                                      </Form.Group>
                                    </div>
                                    <div className='col-xs-12 col-sm-6'>
                                      <Form.Group
                                        controlId='field-sell-stop-loss-disable-buy-minutes'
                                        className='mb-2'>
                                        <Form.Label className='mb-0'>
                                          Temporary disable for buying (minutes){' '}
                                          <OverlayTrigger
                                            trigger='click'
                                            key='sell-stop-loss-disable-buy-minutes-overlay'
                                            placement='bottom'
                                            overlay={
                                              <Popover id='sell-stop-loss-disable-buy-minutes-overlay-right'>
                                                <Popover.Content>
                                                  Set for how long to disable
                                                  buying in minutes after
                                                  placing a stop-loss order.
                                                  i.e. if set <code>360</code>,
                                                  the bot will temporarily
                                                  disable buying for 6 hours.
                                                </Popover.Content>
                                              </Popover>
                                            }>
                                            <Button
                                              variant='link'
                                              className='p-0 m-0 ml-1 text-info'>
                                              <i className='fas fa-question-circle fa-sm'></i>
                                            </Button>
                                          </OverlayTrigger>
                                        </Form.Label>
                                        <Form.Control
                                          size='sm'
                                          type='number'
                                          placeholder='Enter minutes for disabling buy'
                                          required
                                          max='99999999'
                                          min='1'
                                          step='1'
                                          data-state-key='sell.stopLoss.disableBuyMinutes'
                                          value={
                                            symbolConfiguration.sell.stopLoss
                                              .disableBuyMinutes
                                          }
                                          onChange={this.handleInputChange}
                                        />
                                      </Form.Group>
                                    </div>
                                  </div>
                                </Card.Body>
                              </Accordion.Collapse>
                            </Card>
                          </Accordion>
                        </div>

                        <div className='col-12'>
                          <Accordion defaultActiveKey='0'>
                            <Card className='mt-1'>
                              <Card.Header className='px-2 py-1'>
                                <Accordion.Toggle
                                  as={Button}
                                  variant='link'
                                  eventKey='0'
                                  className='p-0 fs-7 text-uppercase'>
                                  TradingView
                                </Accordion.Toggle>
                              </Card.Header>
                              <Accordion.Collapse eventKey='0'>
                                <Card.Body className='px-2 py-1'>
                                  <div className='row'>
                                    <div className='col-12'>
                                      <Form.Group
                                        controlId='field-sell-tradingview-force-sell-over-zero-below-trigger-price-when-neutral'
                                        className='mb-2'>
                                        <Form.Check size='sm'>
                                          <Form.Check.Input
                                            type='checkbox'
                                            data-state-key='sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenNeutral'
                                            checked={
                                              symbolConfiguration.sell
                                                .tradingView
                                                .forceSellOverZeroBelowTriggerPrice
                                                .whenNeutral
                                            }
                                            onChange={this.handleInputChange}
                                          />
                                          <Form.Check.Label>
                                            Force sell at the market price when
                                            recommendation is{' '}
                                            <code>Neutral</code> and the profit
                                            is between <code>0</code> to{' '}
                                            <code>trigger price</code>{' '}
                                            <OverlayTrigger
                                              trigger='click'
                                              key='sell-tradingview-force-sell-over-zero-below-trigger-price-when-neutral-overlay'
                                              placement='bottom'
                                              overlay={
                                                <Popover id='sell-tradingview-force-sell-over-zero-below-trigger-price-when-neutral-overlay-right'>
                                                  <Popover.Content>
                                                    If enabled, the bot will use
                                                    TradingView recommendation
                                                    to sell the coin at the
                                                    market price if the profit
                                                    is over 0 but under the
                                                    trigger price. When the
                                                    condition is met and the
                                                    TradingView recommendation
                                                    is `Neutral`, then the bot
                                                    will place a market sell
                                                    order immediately. If the
                                                    auto-buy trigger is enabled,
                                                    then it will place a buy
                                                    order later. Note that this
                                                    action can cause loss if the
                                                    profit is less than
                                                    commission.
                                                  </Popover.Content>
                                                </Popover>
                                              }>
                                              <Button
                                                variant='link'
                                                className='p-0 m-0 ml-1 text-info'>
                                                <i className='fas fa-question-circle fa-sm'></i>
                                              </Button>
                                            </OverlayTrigger>
                                          </Form.Check.Label>
                                        </Form.Check>
                                      </Form.Group>
                                    </div>
                                    <div className='col-12'>
                                      <Form.Group
                                        controlId='field-sell-tradingview-force-sell-over-zero-below-trigger-price-when-sell'
                                        className='mb-2'>
                                        <Form.Check size='sm'>
                                          <Form.Check.Input
                                            type='checkbox'
                                            data-state-key='sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenSell'
                                            checked={
                                              symbolConfiguration.sell
                                                .tradingView
                                                .forceSellOverZeroBelowTriggerPrice
                                                .whenSell
                                            }
                                            onChange={this.handleInputChange}
                                          />
                                          <Form.Check.Label>
                                            Force sell at the market price when
                                            recommendation is <code>Sell</code>{' '}
                                            and the profit is between{' '}
                                            <code>0</code> to{' '}
                                            <code>trigger price</code>{' '}
                                            <OverlayTrigger
                                              trigger='click'
                                              key='sell-tradingview-force-sell-over-zero-below-trigger-price-when-sell-overlay'
                                              placement='bottom'
                                              overlay={
                                                <Popover id='sell-tradingview-force-sell-over-zero-below-trigger-price-when-sell-overlay-right'>
                                                  <Popover.Content>
                                                    If enabled, the bot will use
                                                    TradingView recommendation
                                                    to sell the coin at the
                                                    market price if the profit
                                                    is over 0 but under the
                                                    trigger price. When the
                                                    condition is met and the
                                                    TradingView recommendation
                                                    is `Sell`, then the bot will
                                                    place a market sell order
                                                    immediately. If the auto-buy
                                                    trigger is enabled, then it
                                                    will place a buy order
                                                    later. Note that this action
                                                    can cause loss if the profit
                                                    is less than commission.
                                                  </Popover.Content>
                                                </Popover>
                                              }>
                                              <Button
                                                variant='link'
                                                className='p-0 m-0 ml-1 text-info'>
                                                <i className='fas fa-question-circle fa-sm'></i>
                                              </Button>
                                            </OverlayTrigger>
                                          </Form.Check.Label>
                                        </Form.Check>
                                      </Form.Group>
                                    </div>
                                    <div className='col-12'>
                                      <Form.Group
                                        controlId='field-sell-tradingview-force-sell-over-zero-below-trigger-price-when-strong-sell'
                                        className='mb-2'>
                                        <Form.Check size='sm'>
                                          <Form.Check.Input
                                            type='checkbox'
                                            data-state-key='sell.tradingView.forceSellOverZeroBelowTriggerPrice.whenStrongSell'
                                            checked={
                                              symbolConfiguration.sell
                                                .tradingView
                                                .forceSellOverZeroBelowTriggerPrice
                                                .whenStrongSell
                                            }
                                            onChange={this.handleInputChange}
                                          />
                                          <Form.Check.Label>
                                            Force sell at the market price when
                                            recommendation is{' '}
                                            <code>Strong sell</code> and the
                                            profit is between <code>0</code> to{' '}
                                            <code>trigger price</code>{' '}
                                            <OverlayTrigger
                                              trigger='click'
                                              key='sell-tradingview-force-sell-over-zero-below-trigger-price-when-strong-sell-overlay'
                                              placement='bottom'
                                              overlay={
                                                <Popover id='sell-tradingview-force-sell-over-zero-below-trigger-price-when-strong-sell-overlay-right'>
                                                  <Popover.Content>
                                                    If enabled, the bot will use
                                                    TradingView recommendation
                                                    to sell the coin at the
                                                    market price if the profit
                                                    is over 0 but under the
                                                    trigger price. When the
                                                    condition is met and the
                                                    TradingView recommendation
                                                    is `Strong sell`, then the
                                                    bot will place a market sell
                                                    order immediately. If the
                                                    auto-buy trigger is enabled,
                                                    then it will place a buy
                                                    order later. Note that this
                                                    action can cause loss if the
                                                    profit is less than
                                                    commission.
                                                  </Popover.Content>
                                                </Popover>
                                              }>
                                              <Button
                                                variant='link'
                                                className='p-0 m-0 ml-1 text-info'>
                                                <i className='fas fa-question-circle fa-sm'></i>
                                              </Button>
                                            </OverlayTrigger>
                                          </Form.Check.Label>
                                        </Form.Check>
                                      </Form.Group>
                                    </div>
                                  </div>
                                </Card.Body>
                              </Accordion.Collapse>
                            </Card>
                          </Accordion>
                        </div>

                        <div className='col-12'>
                          <Accordion defaultActiveKey='0'>
                            <Card className='mt-1'>
                              <Card.Header className='px-2 py-1'>
                                <Accordion.Toggle
                                  as={Button}
                                  variant='link'
                                  eventKey='0'
                                  className='p-0 fs-7 text-uppercase'>
                                  Conservative mode
                                </Accordion.Toggle>
                              </Card.Header>
                              <Accordion.Collapse eventKey='0'>
                                <Card.Body className='px-2 py-1'>
                                  <div className='row'>
                                    <div className='col-12'>
                                      <Form.Group
                                        controlId='field-sell-conservative-enabled'
                                        className='mb-2'>
                                        <Form.Check size='sm'>
                                          <Form.Check.Input
                                            type='checkbox'
                                            data-state-key='sell.conservativeMode.enabled'
                                            checked={
                                              symbolConfiguration.sell
                                                .conservativeMode.enabled
                                            }
                                            onChange={this.handleInputChange}
                                          />
                                          <Form.Check.Label>
                                            Reduce the sell trigger price
                                            proportionally to the number of
                                            executed buy grids - applies only to
                                            grids with at least 2 executed buy
                                            trades{' '}
                                            <OverlayTrigger
                                              trigger='click'
                                              key='sell-conservative-enabled-overlay'
                                              placement='bottom'
                                              overlay={
                                                <Popover id='sell-conservative-enabled-overlay-right'>
                                                  <Popover.Content>
                                                    If enabled, the bot will
                                                    sell at a trigger price
                                                    reduced by the conservative
                                                    ratio for each executed buy
                                                    grid. You can use this
                                                    feature in bear market
                                                    conditions to secure smaller
                                                    benefits over unreached
                                                    higher gains. At least 2 buy
                                                    trades must have been
                                                    executed for the ratio to be
                                                    applied.
                                                  </Popover.Content>
                                                </Popover>
                                              }>
                                              <Button
                                                variant='link'
                                                className='p-0 m-0 ml-1 text-info'>
                                                <i className='fas fa-question-circle fa-sm'></i>
                                              </Button>
                                            </OverlayTrigger>
                                          </Form.Check.Label>
                                        </Form.Check>
                                      </Form.Group>
                                    </div>
                                    <div className='col-xs-12 col-sm-6'>
                                      <Form.Group
                                        controlId='field-sell-conservative-factor'
                                        className='mb-2'>
                                        <Form.Label className='mb-0'>
                                          Conservative ratio{' '}
                                          <OverlayTrigger
                                            trigger='click'
                                            key='sell-conservative-factor-overlay'
                                            placement='bottom'
                                            overlay={
                                              <Popover id='sell-conservative-factor-overlay-right'>
                                                <Popover.Content>
                                                  Set the conservative factor to
                                                  be applied on sell trades with
                                                  at least 2 executed buy grids.
                                                  i.e. if set to{' '}
                                                  <code>0.90</code>, your
                                                  current grid sell percentage
                                                  will be reduced by{' '}
                                                  <code>10%</code> for each
                                                  executed buy grid (except the
                                                  first one). For example, if
                                                  your sell trigger percentage
                                                  is <code>1.10</code>, and you
                                                  have 3 executed buy grids, the
                                                  sell order trigger will be{' '}
                                                  <code>1.081</code>. Remember
                                                  the sell trigger is not
                                                  modified if you have only 1
                                                  executed buy grid.
                                                </Popover.Content>
                                              </Popover>
                                            }>
                                            <Button
                                              variant='link'
                                              className='p-0 m-0 ml-1 text-info'>
                                              <i className='fas fa-question-circle fa-sm'></i>
                                            </Button>
                                          </OverlayTrigger>
                                        </Form.Label>
                                        <Form.Control
                                          size='sm'
                                          type='number'
                                          placeholder='Enter conservative factor'
                                          required
                                          max='1'
                                          min='0'
                                          step='0.01'
                                          data-state-key='sell.conservativeMode.factor'
                                          value={
                                            symbolConfiguration.sell
                                              .conservativeMode.factor
                                          }
                                          onChange={this.handleInputChange}
                                        />
                                      </Form.Group>
                                    </div>
                                  </div>
                                </Card.Body>
                              </Accordion.Collapse>
                            </Card>
                          </Accordion>
                        </div>
                      </div>
                    </Card.Body>
                  </Accordion.Collapse>
                </Card>
              </Accordion>

              <SymbolSettingIconBotOptions
                botOptions={symbolConfiguration.botOptions}
                handleBotOptionsChange={this.handleBotOptionsChange}
              />

              <Accordion defaultActiveKey='0'>
                <Card className='mt-1'>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      Actions
                    </Accordion.Toggle>
                  </Card.Header>
                  <Accordion.Collapse eventKey='0'>
                    <Card.Body className='px-2 py-2'>
                      <div className='row'>
                        <div className='col-12'>
                          <Button
                            variant='danger'
                            size='sm'
                            type='button'
                            className='mr-2'
                            onClick={() => this.handleModalShow('confirm')}>
                            Reset to Global Setting
                          </Button>

                          <Button
                            variant='danger'
                            size='sm'
                            type='button'
                            onClick={() => this.handleModalShow('gridTrade')}>
                            Reset Grid Trade
                          </Button>
                        </div>
                      </div>
                    </Card.Body>
                  </Accordion.Collapse>
                </Card>
              </Accordion>
            </Modal.Body>
            <Modal.Footer>
              <div className='w-100'>
                Note that the changes will be displayed in the frontend in the
                next tick.
              </div>

              <Button
                variant='secondary'
                size='sm'
                type='button'
                onClick={() => this.handleModalClose('setting')}>
                Close
              </Button>
              <Button type='submit' variant='primary' size='sm'>
                Save Changes
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>

        <Modal
          show={this.state.showConfirmModal}
          onHide={() => this.handleModalClose('confirm')}
          size='md'>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>
              <span className='text-danger'>⚠ Reset to Global Setting</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            Warning: You are about to reset the symbol setting to the global
            setting.
            <br />
            <br />
            Do you want to delete current symbol setting?
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('confirm')}>
              Cancel
            </Button>
            <Button
              variant='success'
              size='sm'
              onClick={() => this.resetToGlobalConfiguration()}>
              Yes
            </Button>
          </Modal.Footer>
        </Modal>

        <Modal
          show={this.state.showResetGridTradeModal}
          onHide={() => this.handleModalClose('gridTrade')}
          size='md'>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>
              <span className='text-danger'>⚠ Reset Grid Trade</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            You are about to reset the existing grid trades. If the grid trade
            is already executed, the execution history will be removed.
            <br />
            <br />
            Do you want to reset the grid trade history for the selected symbol?
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('gridTrade')}>
              Cancel
            </Button>
            <Button
              variant='info'
              size='sm'
              onClick={() => this.resetGridTrade('archive')}>
              Archive and delete
            </Button>
            <Button
              variant='danger'
              size='sm'
              onClick={() => this.resetGridTrade('delete')}>
              Delete without archive
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
