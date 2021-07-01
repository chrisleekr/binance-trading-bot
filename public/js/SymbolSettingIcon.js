/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingIcon extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      setting: 'showSettingModal',
      confirm: 'showConfirmModal'
    };

    this.state = {
      showSettingModal: false,
      showConfirmModal: false,
      symbolConfiguration: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);

    this.handleInputChange = this.handleInputChange.bind(this);
    this.resetToGlobalConfiguration =
      this.resetToGlobalConfiguration.bind(this);
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
    this.props.sendWebSocket('symbol-setting-delete', symbolInfo);
  }

  render() {
    const { symbolInfo, jsonStrings } = this.props;
    const { symbolConfiguration } = this.state;

    if (_.isEmpty(symbolConfiguration) || _.isEmpty(jsonStrings)) {
      return '';
    }

    const { settingIcon, commonStrings } = jsonStrings;

    return (
      <div className='symbol-setting-icon-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0'
          onClick={() => this.handleModalShow('setting')}>
          <i className='fa fa-cog'></i>
        </button>
        <Modal
          show={this.state.showSettingModal}
          onHide={() => this.handleModalClose('setting')}
          size='xl'>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>{settingIcon.customise} {symbolInfo.symbol} {commonStrings.settings}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <span className='text-muted'>
                {settingIcon.description}
              </span>
              <Accordion defaultActiveKey='0'>
                <Card className='mt-1'>
                  <Card.Header className='px-2 py-1'>
                    <Accordion.Toggle
                      as={Button}
                      variant='link'
                      eventKey='0'
                      className='p-0 fs-7 text-uppercase'>
                      {settingIcon.candle_settings}
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
                              {commonStrings.interval}
                              <OverlayTrigger
                                trigger='click'
                                key='interval-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='interval-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.candle_interval_description}
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
                              {commonStrings.limit}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='limit-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='limit-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.candle_limit_description}
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
                              placeholder={settingIcon.placeholder_enter_limit_price}
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
                      {settingIcon.buy_sell_conf}
                    </Accordion.Toggle>
                  </Card.Header>
                  <Accordion.Collapse eventKey='0'>
                    <Card.Body className='px-2 py-1'>
                      <div className='row'>
                        <div className='col-xs-12 col-sm-6'>
                          <p className='form-header mb-1'>{commonStrings.buy}</p>
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
                                {commonStrings.trading_enabled}{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='buy-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='buy-enabled-overlay-right'>
                                      <Popover.Content>
                                        {settingIcon.trading_enabled_description}
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

                          <Form.Group
                            controlId='field-last-buy-remove-threshold'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {commonStrings.last_buy_price_remove_threshold}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='last-buy-remove-threshold-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='last-buy-remove-threshold-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.last_buy_price_remove_threshold_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_last_buy_price_remove_threshold}
                                required
                                min='0.0001'
                                step='0.0001'
                                data-state-key='buy.lastBuyPriceRemoveThreshold'
                                value={symbolConfiguration.buy.lastBuyPriceRemoveThreshold}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  ${symbolConfiguration.buy.lastBuyPriceRemoveThreshold}
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-buy-maximum-purchase-amount'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {settingIcon.max_purchase_amount}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='buy-maximum-purchase-amount-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='buy-maximum-purchase-amount-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.max_purchase_amount_symbol_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_max_purchase_amount}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='buy.maxPurchaseAmount'
                                value={symbolConfiguration.buy.maxPurchaseAmount}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  ${symbolConfiguration.buy.maxPurchaseAmount}
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-buy-minimum-purchase-amount'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {settingIcon.min_purchase_amount}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='buy-minimum-purchase-amount-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='buy-minimum-purchase-amount-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.min_purchase_amount_symbol_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_min_purchase_amount}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='buy.minPurchaseAmount'
                                value={symbolConfiguration.buy.minPurchaseAmount}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  ${symbolConfiguration.buy.minPurchaseAmount}
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-buy-trigger-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {settingIcon.trigger_percent_buy}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='buy-trigger-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='buy-trigger-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.trigger_percent_buy_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_trigger_percent}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='buy.triggerPercentage'
                                value={symbolConfiguration.buy.triggerPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.buy.triggerPercentage - 1) * 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-buy-stop-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {commonStrings.stop_price_percent}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='buy-stop-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='buy-stop-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.stop_price_percent_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_enter_stop_price}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='buy.stopPercentage'
                                value={symbolConfiguration.buy.stopPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.buy.stopPercentage * 100) - 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-buy-limit-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {commonStrings.limit_price_percent}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='interval-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='interval-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.limit_price_percent_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_enter_limit_price}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='buy.limitPercentage'
                                value={symbolConfiguration.buy.limitPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.buy.limitPercentage * 100) - 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>
                        </div>
                        <div className='col-xs-12 col-sm-6'>
                          <p className='form-header mb-1'>{commonStrings.sell}</p>
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
                                {commonStrings.trading_enabled}{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='sell-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='sell-enabled-overlay-right'>
                                      <Popover.Content>
                                        {settingIcon.trading_enabled_description_sell}
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

                          <Form.Group
                            controlId='field-sell-market-enabled'
                            className='mb-2'>
                            <Form.Check size='sm'>
                              <Form.Check.Input
                                type='checkbox'
                                data-state-key='sell.marketEnabled'
                                checked={symbolConfiguration.sell.marketEnabled}
                                onChange={this.handleInputChange}
                              />
                              <Form.Check.Label>
                                TODO Sell at Market Order{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='sell-market-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='sell-market-enabled-overlay-right'>
                                      <Popover.Content>
                                        TODO Will sell at market order if trend is going down and current price is higher than your sell trigger.
                                        If true, will sell at market order, if false, limit order.
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

                          <Form.Group
                            controlId='field-sell-last-buy-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {settingIcon.trigger_percent_sell}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-trigger-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-trigger-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.trigger_percent_sell_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_trigger_percent}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='sell.triggerPercentage'
                                value={symbolConfiguration.sell.triggerPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.sell.triggerPercentage - 1) * 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-sell-stop-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {commonStrings.stop_price_percent}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-stop-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-stop-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.stop_price_percent_description_sell}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_enter_stop_price}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='sell.stopPercentage'
                                value={symbolConfiguration.sell.stopPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.sell.stopPercentage * 100) - 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-sell-stop-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {commonStrings.limit_price_percent}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-limit-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-limit-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.limit_price_percent_description_sell}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_enter_limit_price}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='sell.limitPercentage'
                                value={symbolConfiguration.sell.limitPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.sell.limitPercentage * 100) - 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-sell-hard-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              TODO Hard Sell Percentage {' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-hard-price-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-hard-price-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.limit_price_percent_description_sell}
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
                            <Form.Label htmlFor='field-min-sell-hard-price-percentage' srOnly>
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_enter_limit_price}
                                required
                                min='0'
                                step='0.0001'
                                data-state-key='sell.hardPercentage'
                                value={symbolConfiguration.sell.hardPercentage}
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.sell.hardPercentage * 100) - 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <p className='form-header mb-1'>{commonStrings.sell} - {commonStrings.stop_loss}</p>
                          <Form.Group
                            controlId='field-sell-stop-loss-enabled'
                            className='mb-2'>
                            <Form.Check size='sm'>
                              <Form.Check.Input
                                type='checkbox'
                                data-state-key='sell.stopLoss.enabled'
                                checked={symbolConfiguration.sell.stopLoss.enabled}
                                onChange={this.handleInputChange}
                              />
                              <Form.Check.Label>
                                {commonStrings.stop_loss_enabled}{' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='sell-stop-loss-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='sell-stop-loss-enabled-overlay-right'>
                                      <Popover.Content>
                                        {settingIcon.stop_loss_enabled_description}
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

                          <Form.Group
                            controlId='field-sell-stop-loss-max-loss-percentage'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {commonStrings.max_loss_percent}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-stop-loss-max-loss-percentage-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-stop-loss-max-loss-percentage-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.max_loss_percent_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_enter_max_loss}
                                required
                                max='1'
                                min='0'
                                step='0.0001'
                                data-state-key='sell.stopLoss.maxLossPercentage'
                                value={
                                  symbolConfiguration.sell.stopLoss.maxLossPercentage
                                }
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {((symbolConfiguration.sell.stopLoss.maxLossPercentage * 100) - 100).toFixed(2)}%
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <Form.Group
                            controlId='field-sell-stop-loss-disable-buy-minutes'
                            className='mb-2'>
                            <Form.Label className='mb-0'>
                              {settingIcon.temporary_disable_buy}{' '}
                              <OverlayTrigger
                                trigger='click'
                                key='sell-stop-loss-disable-buy-minutes-overlay'
                                placement='bottom'
                                overlay={
                                  <Popover id='sell-stop-loss-disable-buy-minutes-overlay-right'>
                                    <Popover.Content>
                                      {settingIcon.temporary_disable_buy_description}
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
                              {commonStrings.quantity}
                            </Form.Label>
                            <InputGroup size='sm'>

                              <FormControl
                                size='sm'
                                type='number'
                                placeholder={settingIcon.placeholder_temporary_disable}
                                required
                                max='99999999'
                                min='1'
                                step='1'
                                data-state-key='sell.stopLoss.disableBuyMinutes'
                                value={
                                  symbolConfiguration.sell.stopLoss.disableBuyMinutes
                                }
                                onChange={this.handleInputChange}
                              />
                              <InputGroup.Append>
                                <InputGroup.Text>
                                  {(symbolConfiguration.sell.stopLoss.disableBuyMinutes / 60).toFixed(2)} hours disabled.
                                </InputGroup.Text>
                              </InputGroup.Append>
                            </InputGroup>
                          </Form.Group>

                          <p className='form-header mb-1'>TODO - Stake coins?</p>
                          <Form.Group
                            controlId='field-sell-stake-coins-enabled'
                            className='mb-2'>
                            <Form.Check size='sm'>
                              <Form.Check.Input
                                type='checkbox'
                                data-state-key='sell.stakeCoinEnabled'
                                checked={
                                  symbolConfiguration.sell.stakeCoinEnabled
                                }
                                onChange={this.handleInputChange}
                              />
                              <Form.Check.Label>
                                Stake coins {' '}
                                <OverlayTrigger
                                  trigger='click'
                                  key='sell-stake-coins-enabled-overlay'
                                  placement='bottom'
                                  overlay={
                                    <Popover id='sell-stake-coins-enabled-overlay-right'>
                                      <Popover.Content>
                                        When enabled, the bot will sell a little less quantity then what it bought.
                                        Ex: If you set your profit to 0,5% the bot will sell only 99,5% of the amount it bought.
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
            </Modal.Body>
            <Modal.Footer>
              <div className='w-100'>
                {settingIcon.note_changes}
              </div>
              <Button
                variant='danger'
                size='sm'
                type='button'
                onClick={() => this.handleModalShow('confirm')}>
                {settingIcon.reset_global_settings}
              </Button>
              <Button
                variant='secondary'
                size='sm'
                type='button'
                onClick={() => this.handleModalClose('setting')}>
                {commonStrings.close}
              </Button>
              <Button type='submit' variant='primary' size='sm'>
                {commonStrings.save_changes}
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
              <span className='text-danger'>⚠ {settingIcon.reset_global_settings}</span>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {settingIcon.warning_global_save}
            <br />
            <br />
            {settingIcon.delete_symbol_setting}
          </Modal.Body>

          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={() => this.handleModalClose('confirm')}>
              {settingIcon.cancel}
            </Button>
            <Button
              variant='success'
              size='sm'
              onClick={() => this.resetToGlobalConfiguration()}>
              {settingIcon.yes}
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
