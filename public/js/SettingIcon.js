/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      setting: 'showSettingModal',
      confirm: 'showConfirmModal',
      reset: 'showResetModal'
    };

    this.state = {
      showSettingModal: false,
      showConfirmModal: false,
      showResetModal: false,
      availableSymbols: [],
      quoteAssets: [],
      configuration: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);

    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handleResetSettings = this.handleResetSettings.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleMaxPurchaeAmountChange = this.handleMaxPurchaeAmountChange.bind(this);
    this.handleMinPurchaeAmountChange = this.handleMinPurchaeAmountChange.bind(this);
    this.handleLastBuyPriceRemoveThresholdChange = this.handleLastBuyPriceRemoveThresholdChange.bind(this);
  }

  getQuoteAssets(exchangeSymbols, selectedSymbols, maxPurchaseAmounts, lastBuyPriceRemoveThresholds, minPurchaseAmounts) {
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

      if (minPurchaseAmounts[quoteAsset] === undefined) {
        //Define min purchase amount to be min notional + 10% when not set.
        // (+10% to not easily lose its last buy price if is closer to 10 the max purchase amount)
        minPurchaseAmounts[quoteAsset] = (minNotional * 1.1).toFixed(minNotional.length);
      }
    });

    return { quoteAssets, maxPurchaseAmounts, lastBuyPriceRemoveThresholds, minPurchaseAmounts };
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
      if (configuration.buy.minPurchaseAmounts === undefined) {
        configuration.buy.minPurchaseAmounts = {};
      }

      // Set max purchase amount
      const { quoteAssets, maxPurchaseAmounts, lastBuyPriceRemoveThresholds, minPurchaseAmounts } = this.getQuoteAssets(
        exchangeSymbols,
        selectedSymbols,
        configuration.buy.maxPurchaseAmounts,
        configuration.buy.lastBuyPriceRemoveThresholds,
        configuration.buy.minPurchaseAmounts
      );

      configuration.buy.maxPurchaseAmounts = maxPurchaseAmounts;
      configuration.buy.lastBuyPriceRemoveThresholds = lastBuyPriceRemoveThresholds;
      configuration.buy.minPurchaseAmounts = minPurchaseAmounts;

      this.setState({
        availableSymbols,
        quoteAssets,
        configuration
      });
    }
  }

  handleResetSettings(extraConfiguration = {}) {
    this.handleModalClose('reset');
    this.handleModalClose('setting');
    this.props.sendWebSocket('reset-factory-settings', {
      ...this.state.configuration,
      ...extraConfiguration
    });
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

  handleMinPurchaeAmountChange(newMinPurchaseAmounts) {
    const { configuration } = this.state;

    this.setState({
      configuration: _.set(
        configuration,
        'buy.minPurchaseAmounts',
        newMinPurchaseAmounts
      )
    });
  }

  handleLastBuyPriceRemoveThresholdChange(newLastBuyPriceRemoveThresholds) {
    console.log('handleLastBuyPriceRemoveThresholdChange => ', newLastBuyPriceRemoveThresholds);

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
    const { jsonStrings } = this.props;
    const { symbols: selectedSymbols } = configuration;


    if (_.isEmpty(configuration) || _.isEmpty(jsonStrings)) {
      return '';
    }

    const { setting_icon, common_strings } = jsonStrings;

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
              <Modal.Title>{setting_icon.global_settings}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <span className='text-muted'>
                {setting_icon.global_settings_description}
              </span>
              <Accordion
                className='accordion-wrapper'
                defaultActiveKey='0'>
                <Card className='mt-1' style={{ overflow: 'visible' }}>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      {setting_icon._symbols}
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
                                  lastBuyPriceRemoveThresholds,
                                  minPurchaseAmounts
                                } = this.getQuoteAssets(
                                  exchangeSymbols,
                                  selected,
                                  configuration.buy.maxPurchaseAmounts,
                                  configuration.buy.lastBuyPriceRemoveThresholds,
                                  configuration.buy.minPurchaseAmounts
                                );

                                configuration.buy.maxPurchaseAmounts = maxPurchaseAmounts;
                                configuration.buy.lastBuyPriceRemoveThresholds = lastBuyPriceRemoveThresholds;
                                configuration.buy.minPurchaseAmounts = minPurchaseAmounts;
                                this.setState({ configuration, quoteAssets });
                              }}
                              size='sm'
                              options={availableSymbols}
                              defaultSelected={selectedSymbols}
                              placeholder={setting_icon.placeholder_monitor_symbols}
                            />
                          </Form.Group>
                        </div>
                      </div>
                    </Card.Body>
                  </Accordion.Collapse>
                </Card>
              </Accordion>

              <Accordion
                className='accordion-wrapper'
                defaultActiveKey='0'>
                <Card className='mt-1'>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      {setting_icon.candle_settings}
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
                              {common_strings._interval}
                              <OverlayTrigger
                                trigger='click'
                                key='interval-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='interval-overlay-right'>
                                    <Popover.Content>
                                      {setting_icon.candle_interval_description}
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
                              {common_strings._limit}
                              <OverlayTrigger
                                trigger='click'
                                key='limit-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='limit-overlay-right'>
                                    <Popover.Content>
                                      {setting_icon.candle_limit_description}
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
                              placeholder={setting_icon.placeholder_enter_limit_price}
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


              <div className='row'>

                <div className='col-xs-12 col-sm-6'>
                  <Accordion defaultActiveKey='0'
                    className='accordion-wrapper'>
                    <Card className='mt-1 card-buy'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          {common_strings._buy}
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
                                    {common_strings.trading_enabled}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='buy-enabled-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='buy-enabled-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.trading_enabled_description}
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
                            <div className='col-6'>
                              <SettingIconMaxPurchaseAmount
                                quoteAssets={quoteAssets}
                                maxPurchaseAmounts={
                                  configuration.buy.maxPurchaseAmounts
                                }
                                jsonStrings={jsonStrings}
                                handleMaxPurchaeAmountChange={
                                  this.handleMaxPurchaeAmountChange
                                }
                              />
                            </div>
                            <div className='col-6'>
                              <SettingIconMinPurchaseAmount
                                quoteAssets={quoteAssets}
                                minPurchaseAmounts={
                                  configuration.buy.minPurchaseAmounts
                                }
                                jsonStrings={jsonStrings}
                                handleMinPurchaeAmountChange={
                                  this.handleMinPurchaeAmountChange
                                }
                              />
                            </div>
                            <div className='col-12'>
                              <SettingIconLastBuyPriceRemoveThreshold
                                quoteAssets={quoteAssets}
                                lastBuyPriceRemoveThresholds={
                                  configuration.buy.lastBuyPriceRemoveThresholds
                                }
                                jsonStrings={jsonStrings}
                                handleLastBuyPriceRemoveThresholdChange={
                                  this.handleLastBuyPriceRemoveThresholdChange
                                }
                              />
                            </div>
                          </div>
                          <div className='row'>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-buy-trigger-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.trigger_percent_buy}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='buy-trigger-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='buy-trigger-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.trigger_percent_buy_description}
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
                                <Form.Label htmlFor='field-min-sell-stop-loss-percentage' srOnly>
                                  {common_strings._quantity}
                                </Form.Label>
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_trigger_percent}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='buy.triggerPercentage'
                                    value={configuration.buy.triggerPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.buy.triggerPercentage - 1) * 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-buy-stop-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {common_strings.stop_price_percent}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='buy-stop-price-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='buy-stop-price-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.stop_price_percent_description}
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
                                <Form.Label htmlFor='field-min-buy-stop-price-percentage' srOnly>
                                  {common_strings._quantity}
                                </Form.Label>
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_enter_stop_price}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='buy.stopPercentage'
                                    value={configuration.buy.stopPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.buy.stopPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-buy-limit-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {common_strings.limit_price_percent}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='interval-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='interval-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.limit_price_percent_description}
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
                                <Form.Label htmlFor='field-min-buy-limit-percentage' srOnly>
                                  {common_strings._quantity}
                                </Form.Label>
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_enter_limit_price}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='buy.limitPercentage'
                                    value={configuration.buy.limitPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.buy.limitPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                          </div>
                        </Card.Body>
                      </Accordion.Collapse>
                    </Card>
                  </Accordion>
                </div>

                <div className='col-xs-12 col-sm-6'>
                  <Accordion defaultActiveKey='0'
                    className='accordion-wrapper'>
                    <Card className='mt-1 card-sell'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          {common_strings._sell}
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
                                    {common_strings.trading_enabled}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='sell-enabled-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='sell-enabled-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.trading_enabled_description_sell}
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
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-sell-last-buy-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.trigger_percent_sell}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='sell-trigger-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='sell-trigger-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.trigger_percent_sell_description}
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
                                <Form.Label htmlFor='field-min-sell-trigger-percentage' srOnly>
                                  {common_strings._quantity}
                                </Form.Label>
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_trigger_percent}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='sell.triggerPercentage'
                                    value={configuration.sell.triggerPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.sell.triggerPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-sell-stop-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {common_strings.stop_price_percent}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='sell-stop-price-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='sell-stop-price-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.stop_price_percent_description_sell}
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
                                <Form.Label htmlFor='field-min-sell-stop-price-percentage' srOnly>
                                  {common_strings._quantity}
                                </Form.Label>
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_enter_stop_price}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='sell.stopPercentage'
                                    value={configuration.sell.stopPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.sell.stopPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>

                            </div>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-sell-stop-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {common_strings.limit_price_percent}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='sell-limit-price-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='sell-limit-price-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.limit_price_percent_description_sell}
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
                                <Form.Label htmlFor='field-min-sell-limit-price-percentage' srOnly>
                                  {common_strings._quantity}
                                </Form.Label>
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_enter_limit_price}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='sell.limitPercentage'
                                    value={configuration.sell.limitPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.sell.limitPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>

                            </div>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-sell-hard-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.hard_sell_trigger} {' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='sell-hard-price-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='sell-hard-price-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.hard_sell_trigger_description}
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
                                <InputGroup size='sm'>
                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_hard_sell_trigger}
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='sell.hardPercentage'
                                    value={configuration.sell.hardPercentage}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.sell.hardPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>

                            </div>
                            <div className='col-12'>
                              <p className='form-header mb-1'>{common_strings._sell} - {common_strings.stop_loss}</p>
                              <Form.Group
                                controlId='field-sell-stop-loss-enabled'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='sell.stopLoss.enabled'
                                    checked={configuration.sell.stopLoss.enabled}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {common_strings.stop_loss_enabled}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='sell-stop-loss-enabled-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='sell-stop-loss-enabled-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.stop_loss_enabled_description}
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
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-sell-stop-loss-max-loss-percentage'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {common_strings.max_loss_percent}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='sell-stop-loss-max-loss-percentage-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='sell-stop-loss-max-loss-percentage-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.max_loss_percent_description}
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
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_enter_max_loss}
                                    required
                                    max='1'
                                    min='0'
                                    step='0.0001'
                                    data-state-key='sell.stopLoss.maxLossPercentage'
                                    value={
                                      configuration.sell.stopLoss.maxLossPercentage
                                    }
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.sell.stopLoss.maxLossPercentage * 100) - 100).toFixed(2)}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>

                            </div>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-sell-stop-loss-disable-buy-minutes'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.temporary_disable_buy}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='sell-stop-loss-disable-buy-minutes-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='sell-stop-loss-disable-buy-minutes-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.temporary_disable_buy_description}
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
                                <InputGroup size='sm'>

                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder={setting_icon.placeholder_temporary_disable}
                                    required
                                    max='99999999'
                                    min='1'
                                    step='1'
                                    data-state-key='sell.stopLoss.disableBuyMinutes'
                                    value={
                                      configuration.sell.stopLoss.disableBuyMinutes
                                    }
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {(configuration.sell.stopLoss.disableBuyMinutes / 60).toFixed(2)} hours disabled.
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>

                          </div>
                        </Card.Body>
                      </Accordion.Collapse>
                    </Card>
                  </Accordion>

                </div>
              </div>


              <div className='row'>
                <div className='col-xs-12 col-sm-6'>

                  <Accordion
                    className='accordion-wrapper accordion-floating'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          {setting_icon.grid_buy_strategy_activate}
                        </Accordion.Toggle>
                      </Card.Header>
                      <Accordion.Collapse eventKey='0'>
                        <Card.Body className='px-2 py-1'>
                          <div className='row'>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-trade-options-many-buys'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='strategyOptions.tradeOptions.manyBuys'
                                    checked={configuration.strategyOptions.tradeOptions.manyBuys}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.grid_buy_strategy_activate}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='trade-options-many-buys-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='trade-options-many-buys-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.grid_buy_strategy_activate_description}
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
                          </div>
                          <div className='row'>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-buy-after-difference-amount'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.grid_buy_strategy}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='buy-after-difference-amount-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='buy-after-difference-amount-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.grid_buy_strategy_description}
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
                                <InputGroup size='sm'>
                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder="5"
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='strategyOptions.tradeOptions.differenceToBuy'
                                    value={configuration.strategyOptions.tradeOptions.differenceToBuy}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {configuration.strategyOptions.tradeOptions.differenceToBuy}%
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                          </div>
                        </Card.Body>
                      </Accordion.Collapse>
                    </Card>
                  </Accordion>

                  <Accordion
                    className='accordion-wrapper accordion-floating'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          {setting_icon.stake_coins} ?
                        </Accordion.Toggle>
                      </Card.Header>
                      <Accordion.Collapse eventKey='0'>
                        <Card.Body className='px-2 py-1'>
                          <div className='row'>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-sell-stake-coins-enabled'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='sell.stakeCoinEnabled'
                                    checked={
                                      configuration.sell.stakeCoinEnabled
                                    }
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.stake_coins} {' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='sell-stake-coins-enabled-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='sell-stake-coins-enabled-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.stake_coins_description}
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
                          </div>
                        </Card.Body>
                      </Accordion.Collapse>
                    </Card>
                  </Accordion>

                </div>

                <div className='col-xs-12 col-sm-6'>
                  <Accordion
                    className='accordion-wrapper accordion-floating'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          Husky Indicator
                        </Accordion.Toggle>
                      </Card.Header>
                      <Accordion.Collapse eventKey='0'>
                        <Card.Body className='px-2 py-1'>
                          <div className='row'>
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-husky-options-buy-signal'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='strategyOptions.huskyOptions.buySignal'
                                    checked={configuration.strategyOptions.huskyOptions.buySignal}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.use_husky_buy}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='husky-options-buy-signal-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='husky-options-buy-signal-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.use_husky_buy_description}
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
                            <div className='col-6'>
                              <Form.Group
                                controlId='field-husky-options-sell-signal'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='strategyOptions.huskyOptions.sellSignal'
                                    checked={configuration.strategyOptions.huskyOptions.sellSignal}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.use_husky_sell}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='husky-options-sell-signal-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='husky-options-sell-signal-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.use_husky_sell_description}
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
                          </div>
                          <div className='row'>
                            <div className='col-12'>
                              <Form.Group
                                controlId='field-husky-positive'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.weight_green_candle}{' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='husky-positive-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='husky-positive-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.weight_green_candle_description}
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
                                <InputGroup size='sm'>
                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder="1"
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='strategyOptions.huskyOptions.positive'
                                    value={configuration.strategyOptions.huskyOptions.positive}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.strategyOptions.huskyOptions.positive - 1) * 100).toFixed(2)}% heavier than negative
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>

                              <Form.Group
                                controlId='field-husky-negative'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.weight_red_candle} {' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='husky-negative-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='husky-negative-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.weight_red_candle_description}
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
                                <InputGroup size='sm'>
                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder="1.25"
                                    required
                                    min='0'
                                    step='0.0001'
                                    data-state-key='strategyOptions.huskyOptions.negative'
                                    value={configuration.strategyOptions.huskyOptions.negative}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {((configuration.strategyOptions.huskyOptions.negative - 1) * 100).toFixed(2)}% heavier than positive
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                          </div>
                          <div className='row'>
                            <div className='col-12'>
                              <p className='form-header mb-1'>{setting_icon.force_market_order} ?</p>
                              <Form.Group
                                controlId='field-sell-market-enabled'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='sell.trendDownMarketSell'
                                    checked={configuration.sell.trendDownMarketSell}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.sell_market_order}{' '}
                                    <OverlayTrigger
                                      trigger='click'
                                      key='sell-market-enabled-overlay'
                                      placement='bottom'
                                      overlay={
                                        <Popover id='sell-market-enabled-overlay-right'>
                                          <Popover.Content>
                                            {setting_icon.sell_market_order_description}
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
                          </div>
                        </Card.Body>
                      </Accordion.Collapse>
                    </Card>
                  </Accordion>

                  <Accordion
                    className='accordion-wrapper accordion-floating'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          ATH (All Time High) Buy Restriction
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
                                    data-state-key='strategyOptions.athRestriction.enabled'
                                    checked={
                                      configuration.strategyOptions.athRestriction.enabled
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
                                            If enabled, the bot will retrieve ATH
                                            (All Time High) price of the coin based
                                            on the interval/candle configuration. If
                                            the buy trigger price is higher than ATH
                                            buy restriction price, which is
                                            calculated by ATH Restriction price
                                            percentage, the bot will not place a buy
                                            order. The bot will place an order when
                                            the trigger price is lower than ATH buy
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
                          </div>
                          <div className='row'>
                            <div className='col-6'>
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
                                          Set candle interval for calculating the
                                          ATH (All The High) price.
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
                                  data-state-key='strategyOptions.athRestriction.candles.interval'
                                  value={
                                    configuration.strategyOptions.athRestriction.candles
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
                            <div className='col-6'>
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
                                          Set the number of candles to retrieve for
                                          calculating the ATH (All The High) price.
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
                                  data-state-key='strategyOptions.athRestriction.candles.limit'
                                  value={
                                    configuration.strategyOptions.athRestriction.candles.limit
                                  }
                                  onChange={this.handleInputChange}
                                />
                              </Form.Group>
                            </div>
                          </div>
                          <div className='row'>
                            <div className='col-12'>
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
                                          <code>0.9</code> and the ATH(All Time
                                          High) price <code>$110</code>, restriction
                                          price will be <code>$99</code> for stop
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
                                  placeholder='Enter restriction price percentage'
                                  required
                                  min='0'
                                  step='0.0001'
                                  data-state-key='buy.athRestriction.restrictionPercentage'
                                  value={
                                    configuration.strategyOptions.athRestriction
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

                </div>

                <div className='col-12'>
                  <Accordion
                    className='accordion-wrapper accordion-floating'>
                    <Card className='mt-1'>
                      <Card.Header className='px-2 py-1'>
                        <Accordion.Toggle
                          as={Button}
                          variant='link'
                          eventKey='0'
                          className='p-0 fs-7 text-uppercase'>
                          {setting_icon.bot_options.bot_options}
                        </Accordion.Toggle>
                      </Card.Header>
                      <Accordion.Collapse eventKey='0'>
                        <Card.Body className='px-2 py-1'>
                          <div className='row'>
                            <div className='col-12'>
                              <p className='form-header mb-1'>{setting_icon.bot_options._language}</p>

                              <Form.Group
                                controlId='field-languages'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.bot_options.select_language}
                                </Form.Label>
                                <Form.Control
                                  size='sm'
                                  as='select'
                                  required
                                  data-state-key='botOptions.language'
                                  value={configuration.botOptions.language}
                                  onChange={this.handleInputChange}>
                                  <option value='en'>en</option>
                                  <option value='es'>es</option>
                                  <option value='pt'>pt</option>
                                  <option value='vi'>vi</option>
                                  <option value='ch'>ch</option>
                                  <option value='fr'>fr</option>
                                  <option value='nl'>nl</option>
                                </Form.Control>
                              </Form.Group>
                            </div>
                          </div>
                          <div className='row'>
                            <div className='col-6'>
                              <p className='form-header mb-1'>Slack</p>
                              <Form.Group
                                controlId='field-bot-options-slack'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='botOptions.slack'
                                    checked={configuration.botOptions.slack}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.bot_options.use_slack}?{' '}
                                  </Form.Check.Label>
                                </Form.Check>
                              </Form.Group>
                            </div>
                            <div className='col-6'>
                              <p className='form-header mb-1'>Telegram</p>

                              <Form.Group
                                controlId='field-bot-options-telegram'
                                className='mb-2'>
                                <Form.Check size='sm'>
                                  <Form.Check.Input
                                    type='checkbox'
                                    data-state-key='botOptions.telegram'
                                    checked={configuration.botOptions.telegram}
                                    onChange={this.handleInputChange}
                                  />
                                  <Form.Check.Label>
                                    {setting_icon.bot_options.use_telegram}?{' '}
                                  </Form.Check.Label>
                                </Form.Check>
                              </Form.Group>
                            </div>
                          </div>
                          <div className='row'>
                            <div className='col-12'>
                              <p className='form-header mb-1'>{setting_icon.bot_options._security}</p>

                              <Form.Group
                                controlId='field-login-expire'
                                className='mb-2'>
                                <Form.Label className='mb-0'>
                                  {setting_icon.bot_options.login_expire_time} {' '}
                                  <OverlayTrigger
                                    trigger='click'
                                    key='login-expire-overlay'
                                    placement='bottom'
                                    overlay={
                                      <Popover id='login-expire-overlay-right'>
                                        <Popover.Content>
                                          {setting_icon.bot_options.login_expire_time_description}
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
                                <InputGroup size='sm'>
                                  <FormControl
                                    size='sm'
                                    type='number'
                                    placeholder="60 is the default"
                                    required
                                    min='0'
                                    step='1'
                                    data-state-key='botOptions.login.loginWindowMinutes'
                                    value={configuration.botOptions.login.loginWindowMinutes}
                                    onChange={this.handleInputChange}
                                  />
                                  <InputGroup.Append>
                                    <InputGroup.Text>
                                      {setting_icon.bot_options.expire_after} {configuration.botOptions.login.loginWindowMinutes} {setting_icon.bot_options._minutes}.
                                    </InputGroup.Text>
                                  </InputGroup.Append>
                                </InputGroup>
                              </Form.Group>
                            </div>
                          </div>
                        </Card.Body>
                      </Accordion.Collapse>
                    </Card>
                  </Accordion>

                </div>
              </div>

            </Modal.Body>
            <Modal.Footer>
              <div className='w-100'>
                {setting_icon.note_changes}
              </div>
              <Button
                variant='danger'
                size='sm'
                onClick={() =>
                  this.handleModalShow('reset')
                }>
                {setting_icon.reset_factory.reset_factory}
              </Button>
              <Button
                variant='secondary'
                size='sm'
                onClick={() => this.handleModalClose('setting')}>
                {common_strings._close}
              </Button>
              <Button
                variant='primary'
                size='sm'
                onClick={() => this.handleModalShow('confirm')}>
                {common_strings.save_changes}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>

        <Modal
          show={this.state.showResetModal}
          onHide={() => this.handleModalClose('reset')}
          size='md'>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>
              <span className='text-danger'>⚠ {setting_icon.reset_factory.delete_all}</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {setting_icon.reset_factory.delete_all_description[1]}
            <br />
            <br />
            {setting_icon.reset_factory.delete_all_description[2]}
            <br />
            <br />
            {setting_icon.reset_factory.delete_all_description[3]}
            <br />
            <br />
            {setting_icon.reset_factory.delete_all_description[4]}
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('reset')}>
              {setting_icon._cancel}
            </Button>
            <Button
              variant='primary'
              size='sm'
              onClick={() => this.handleResetSettings({
                action: 'reset-factory-settings'
              })}>
              Reset All
            </Button>
            <Button
              variant='primary'
              size='sm'
              onClick={() => this.handleResetSettings({
                action: 'reset-factory-settings-minus-symbols'
              })}>
              {setting_icon.reset_factory.delete_all_keeps_symbols}
            </Button>
          </Modal.Footer>
        </Modal>

        <Modal
          show={this.state.showConfirmModal}
          onHide={() => this.handleModalClose('confirm')}
          size='md'>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>
              <span className='text-danger'>⚠ {common_strings.save_changes}</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {setting_icon.warning_global_save}
            <br />
            <br />
            {setting_icon.ask_all_or_global}
            <br />
            <br />
            {setting_icon.choosed_all_symbols}
            <br />
            <br />
            {setting_icon.choosed_global}
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('confirm')}>
              {setting_icon._cancel}
            </Button>
            <Button
              variant='success'
              size='sm'
              onClick={() => this.handleFormSubmit({ action: 'apply-to-all' })}>
              {setting_icon.apply_all_symbols}
            </Button>
            <Button
              variant='primary'
              size='sm'
              onClick={() =>
                this.handleFormSubmit({
                  action: 'apply-to-global-only'
                })
              }>
              {setting_icon.apply_global_only}
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
