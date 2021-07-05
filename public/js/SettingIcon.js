/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      setting: 'showSettingModal',
      confirm: 'showConfirmModal'
    };

    this.state = {
      showSettingModal: false,
      showConfirmModal: false,
      availableSymbols: [],
      quoteAssets: [],
      configuration: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);

    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleMaxPurchaeAmountChange =
      this.handleMaxPurchaeAmountChange.bind(this);
    this.handleLastBuyPriceRemoveThresholdChange =
      this.handleLastBuyPriceRemoveThresholdChange.bind(this);
  }

  getQuoteAssets(
    exchangeSymbols,
    selectedSymbols,
    maxPurchaseAmounts,
    lastBuyPriceRemoveThresholds
  ) {
    const quoteAssets = [];

    selectedSymbols.forEach(symbol => {
      const symbolInfo = exchangeSymbols[symbol];
      if (symbolInfo === undefined) {
        return;
      }
      const { quoteAsset, minNotional } = symbolInfo;
      if (quoteAssets.includes(quoteAsset) === false) {
        quoteAssets.push(quoteAsset);
      }
      if (maxPurchaseAmounts[quoteAsset] === undefined) {
        maxPurchaseAmounts[quoteAsset] = minNotional * 10;
      }
      if (lastBuyPriceRemoveThresholds[quoteAsset] === undefined) {
        lastBuyPriceRemoveThresholds[quoteAsset] = minNotional;
      }
    });

    return { quoteAssets, maxPurchaseAmounts, lastBuyPriceRemoveThresholds };
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      this.state.showSettingModal === false &&
      _.isEmpty(nextProps.configuration) === false &&
      _.isEqual(nextProps.configuration, this.state.configuration) === false
    ) {
      const { exchangeSymbols, configuration } = nextProps;
      const { symbols: selectedSymbols } = configuration;

      const availableSymbols = _.reduce(
        exchangeSymbols,
        (acc, symbol) => {
          acc.push(symbol.symbol);
          return acc;
        },
        []
      );

      if (configuration.buy.maxPurchaseAmounts === undefined) {
        configuration.buy.maxPurchaseAmounts = {};
      }
      if (configuration.buy.lastBuyPriceRemoveThresholds === undefined) {
        configuration.buy.lastBuyPriceRemoveThresholds = {};
      }

      // Set max purchase amount
      const { quoteAssets, maxPurchaseAmounts, lastBuyPriceRemoveThresholds } =
        this.getQuoteAssets(
          exchangeSymbols,
          selectedSymbols,
          configuration.buy.maxPurchaseAmounts,
          configuration.buy.lastBuyPriceRemoveThresholds
        );

      configuration.buy.maxPurchaseAmounts = maxPurchaseAmounts;
      configuration.buy.lastBuyPriceRemoveThresholds =
        lastBuyPriceRemoveThresholds;

      this.setState({
        availableSymbols,
        quoteAssets,
        configuration
      });
    }
  }

  handleFormSubmit(extraConfiguration = {}) {
    this.handleModalClose('confirm');
    this.handleModalClose('setting');
    this.props.sendWebSocket('setting-update', {
      ...this.state.configuration,
      ...extraConfiguration
    });
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

    const { configuration } = this.state;

    this.setState({
      configuration: _.set(configuration, stateKey, value)
    });
  }

  handleMaxPurchaeAmountChange(newMaxPurchaseAmounts) {
    const { configuration } = this.state;

    this.setState({
      configuration: _.set(
        configuration,
        'buy.maxPurchaseAmounts',
        newMaxPurchaseAmounts
      )
    });
  }

  handleLastBuyPriceRemoveThresholdChange(newLastBuyPriceRemoveThresholds) {
    console.log(
      'handleLastBuyPriceRemoveThresholdChange => ',
      newLastBuyPriceRemoveThresholds
    );

    const { configuration } = this.state;

    this.setState({
      configuration: _.set(
        configuration,
        'buy.lastBuyPriceRemoveThresholds',
        newLastBuyPriceRemoveThresholds
      )
    });
  }

  render() {
    const { configuration, availableSymbols, quoteAssets } = this.state;
    const { symbols: selectedSymbols } = configuration;

    if (_.isEmpty(configuration)) {
      return '';
    }

    return (
      <div className='header-column-icon-wrapper setting-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 pl-1 pr-1'
          onClick={() => this.handleModalShow('setting')}>
          <i className='fa fa-cog'></i>
        </button>
        <Modal
          show={this.state.showSettingModal}
          onHide={() => this.handleModalClose('setting)')}
          size='xl'>
          <Form>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>Global Settings</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <span className='text-muted'>
                In this modal, you can configure the global configuration. If
                the symbol has a specific configuration, the change won't impact
                the symbol. Please make sure you understand what the setting is
                about before changing the configuration value.
              </span>
              <Accordion defaultActiveKey='0'>
                <Card className='mt-1' style={{ overflow: 'visible' }}>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      Symbols
                    </Accordion.Toggle>
                  </Card.Header>
                  <Accordion.Collapse eventKey='0'>
                    <Card.Body className='px-2 py-1'>
                      <div className='row'>
                        <div className='col-12'>
                          <Form.Group className='mb-2'>
                            <Typeahead
                              multiple
                              onChange={selected => {
                                // Handle selections...
                                const { configuration } = this.state;
                                const { exchangeSymbols } = this.props;

                                configuration.symbols = selected;

                                const {
                                  quoteAssets,
                                  maxPurchaseAmounts,
                                  lastBuyPriceRemoveThresholds
                                } = this.getQuoteAssets(
                                  exchangeSymbols,
                                  selected,
                                  configuration.buy.maxPurchaseAmounts,
                                  configuration.buy.lastBuyPriceRemoveThresholds
                                );

                                configuration.buy.maxPurchaseAmounts =
                                  maxPurchaseAmounts;
                                configuration.buy.lastBuyPriceRemoveThresholds =
                                  lastBuyPriceRemoveThresholds;
                                this.setState({ configuration, quoteAssets });
                              }}
                              size='sm'
                              options={availableSymbols}
                              defaultSelected={selectedSymbols}
                              placeholder='Choose symbols to monitor...'
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
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              as='select'
                              required
                              data-state-key='candles.interval'
                              value={configuration.candles.interval}
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
                              Limit
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
                                  <i className='fa fa-question-circle'></i>
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
                              value={configuration.candles.limit}
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
                                checked={configuration.buy.enabled}
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
                                    <i className='fa fa-question-circle'></i>
                                  </Button>
                                </OverlayTrigger>
                              </Form.Check.Label>
                            </Form.Check>
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <SettingIconMaxPurchaseAmount
                            quoteAssets={quoteAssets}
                            maxPurchaseAmounts={
                              configuration.buy.maxPurchaseAmounts
                            }
                            handleMaxPurchaeAmountChange={
                              this.handleMaxPurchaeAmountChange
                            }
                          />
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <SettingIconLastBuyPriceRemoveThreshold
                            quoteAssets={quoteAssets}
                            lastBuyPriceRemoveThresholds={
                              configuration.buy.lastBuyPriceRemoveThresholds
                            }
                            handleLastBuyPriceRemoveThresholdChange={
                              this.handleLastBuyPriceRemoveThresholdChange
                            }
                          />
                        </div>
                        <div className='col-12'>
                          <hr />
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group
                            controlId='field-buy-trigger-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Trigger percentage{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='buy-trigger-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='buy-trigger-percentage-overlay-right'>
                                    <Popover.Content>
                                      Set the trigger percentage for buying.
                                      i.e. if set <code>1.01</code> and the
                                      lowest price is <code>$100</code>, then
                                      the bot will buy the coin when the current
                                      price reaches <code>$101</code>. You
                                      cannot set less than <code>1</code>,
                                      because it will never reach the trigger
                                      price unless there is a deep decline
                                      before the next process.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter trigger percentage'
                              required
                              min='0'
                              step='0.0001'
                              data-state-key='buy.triggerPercentage'
                              value={configuration.buy.triggerPercentage}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group
                            controlId='field-buy-stop-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Stop price percentage{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='buy-stop-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='buy-stop-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      Set the percentage to calculate stop
                                      price. i.e. if set <code>1.01</code> and
                                      current price <code>$100</code>, stop
                                      price will be <code>$101</code> for stop
                                      limit order.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter stop price percentage'
                              required
                              min='0'
                              step='0.0001'
                              data-state-key='buy.stopPercentage'
                              value={configuration.buy.stopPercentage}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group
                            controlId='field-buy-limit-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Limit price percentage{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='interval-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='interval-overlay-right'>
                                    <Popover.Content>
                                      Set the percentage to calculate limit
                                      price. i.e. if set <code>1.011</code> and
                                      current price <code>$100</code>, limit
                                      price will be <code>$101.10</code> for
                                      stop limit order.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter limit price percentage'
                              required
                              min='0'
                              step='0.0001'
                              data-state-key='buy.limitPercentage'
                              value={configuration.buy.limitPercentage}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
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
                                          configuration.buy.athRestriction
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
                                            <i className='fa fa-question-circle'></i>
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
                                          <i className='fa fa-question-circle'></i>
                                        </Button>
                                      </OverlayTrigger>
                                    </Form.Label>
                                    <Form.Control
                                      size='sm'
                                      as='select'
                                      required
                                      data-state-key='buy.athRestriction.candles.interval'
                                      value={
                                        configuration.buy.athRestriction.candles
                                          .interval
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
                                          <i className='fa fa-question-circle'></i>
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
                                        configuration.buy.athRestriction.candles
                                          .limit
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
                                          <i className='fa fa-question-circle'></i>
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
                                        configuration.buy.athRestriction
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
                                checked={configuration.sell.enabled}
                                onChange={this.handleInputChange}
                              />
                              <Form.Check.Label>
                                Trading Enabled{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='sell-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='sell-enabled-overlay-right'>
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
                                    <i className='fa fa-question-circle'></i>
                                  </Button>
                                </OverlayTrigger>
                              </Form.Check.Label>
                            </Form.Check>
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group
                            controlId='field-sell-last-buy-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Trigger percentage{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-trigger-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-trigger-percentage-overlay-right'>
                                    <Popover.Content>
                                      Set the trigger percentage for minimum
                                      profit. i.e. if set <code>1.06</code>,
                                      minimum profit will be <code>6%</code>. So
                                      if the last buy price is <code>$100</code>
                                      , then the bot will sell the coin when the
                                      current price reaches <code>$106</code>.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter trigger percentage'
                              required
                              min='0'
                              step='0.0001'
                              data-state-key='sell.triggerPercentage'
                              value={configuration.sell.triggerPercentage}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group
                            controlId='field-sell-stop-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Stop price percentage{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-stop-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-stop-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      Set the percentage to calculate stop
                                      price. i.e. if set <code>0.99</code> and
                                      current price <code>$106</code>, stop
                                      price will be <code>$104.94</code> for
                                      stop limit order.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter stop price percentage'
                              required
                              min='0'
                              step='0.0001'
                              data-state-key='sell.stopPercentage'
                              value={configuration.sell.stopPercentage}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <Form.Group
                            controlId='field-sell-stop-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              Limit price percentage{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-limit-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-limit-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      Set the percentage to calculate limit
                                      price. i.e. if set <code>0.98</code> and
                                      current price <code>$106</code>, limit
                                      price will be <code>$103.88</code> for
                                      stop limit order.
                                    </Popover.Content>
                                  </Popover>
                                }>
                                <Button
                                  variant='link'
                                  className='p-0 m-0 ml-1 text-info'>
                                  <i className='fa fa-question-circle'></i>
                                </Button>
                              </OverlayTrigger>
                            </Form.Label>
                            <Form.Control
                              size='sm'
                              type='number'
                              placeholder='Enter limit price percentage'
                              required
                              min='0'
                              step='0.0001'
                              data-state-key='sell.limitPercentage'
                              value={configuration.sell.limitPercentage}
                              onChange={this.handleInputChange}
                            />
                          </Form.Group>
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
                                              configuration.sell.stopLoss
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
                                                <i className='fa fa-question-circle'></i>
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
                                              <i className='fa fa-question-circle'></i>
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
                                            configuration.sell.stopLoss
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
                                              <i className='fa fa-question-circle'></i>
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
                                            configuration.sell.stopLoss
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
                onClick={() => this.handleModalClose('setting')}>
                Close
              </Button>
              <Button
                variant='primary'
                size='sm'
                onClick={() => this.handleModalShow('confirm')}>
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
              <span className='text-danger'>⚠ Save Changes</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            Warning: You are about to save the global configuration.
            <br />
            <br />
            Do you want to apply the changes for all symbols or just global
            configuration?
            <br />
            <br />
            If you choose to apply for all symbols, then customised symbol
            configurations will be removed.
            <br />
            <br />
            If you choose to apply the global configuration only, then the
            symbols that are different from the global configuration will be
            displayed as customised.
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
              onClick={() => this.handleFormSubmit({ action: 'apply-to-all' })}>
              Apply to all symbols
            </Button>
            <Button
              variant='primary'
              size='sm'
              onClick={() =>
                this.handleFormSubmit({
                  action: 'apply-to-global-only'
                })
              }>
              Apply to global only
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
