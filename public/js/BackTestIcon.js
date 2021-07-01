/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class BackTestIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      symbolConfiguration: {}
    };


    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);

    this.handleInputChange = this.handleInputChange.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update, when the canUpdate is true.
    if (
      this.state.showModal === false &&
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

  handleModalShow() {
    this.setState({
      showModal: true
    });
  }

  handleModalClose() {
    this.setState({
      showModal: false
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

    console.log(this.state)
  }

  handleFormSubmit() {


    const { symbolInfo } = this.props;
    const newSymbolInfo = symbolInfo;
    newSymbolInfo.configuration = this.state.symbolConfiguration;

    this.props.sendWebSocket('symbol-backtest', newSymbolInfo);
    console.log(newSymbolInfo)
    //   this.handleModalClose();


  }

  render() {
    const { showModal, symbolConfiguration } = this.state;
    const { symbolInfo, jsonStrings } = this.props;


    if (_.isEmpty(symbolInfo) || _.isEmpty(symbolConfiguration) || _.isEmpty(jsonStrings)) {
      return '';
    };

    const { symbolConfiguration: { backtest: { result } } } = this.state;

    const { settingIcon, commonStrings } = jsonStrings;

    return (
      <div className='coin-info-manual-trade-wrapper'>
        <div className='coin-info-column coin-info-column-manual-trade d-flex flex-row justify-content-start align-content-between border-bottom-0 mb-0 pb-0'>
          <button
            type='button'
            className='btn btn-sm btn-backtest mr-1'
            onClick={() => this.handleModalShow()}>
            <i className='fa fa-shopping-bag'></i> Backtest
          </button>
        </div>
        <Modal show={showModal} onHide={() => this.handleModalClose()} backdrop='static' size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Backtest</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className='d-block text-muted mb-2'>
              UNDER CONSTRUCTION
            </p>

            <Form.Group
              controlId='field-backtest-days-to-test'
              className='mb-2'>
              <Form.Label className='mb-0'>
                How much days to test{' '}
                <OverlayTrigger
                  trigger='click'
                  key='days-to-test-overlay'
                  placement='bottom'
                  overlay={
                    <Popover id='backtest-days-to-test-overlay-right'>
                      <Popover.Content>
                        UNDER CONSTRUCTION
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
                placeholder="Number of days to test"
                required
                min='0'
                step='0.0001'
                data-state-key='backtest.daysToTest'
                value={symbolConfiguration.backtest.daysToTest}
                onChange={this.handleInputChange}
              />
            </Form.Group>

            <Form.Group
              controlId='field-backtest-money-to-test'
              className='mb-2'>
              <Form.Label className='mb-0'>
                How much money to start test{' '}
                <OverlayTrigger
                  trigger='click'
                  key='backtest-money-to-test-overlay'
                  placement='bottom'
                  overlay={
                    <Popover id='backtest-money-to-test-overlay-right'>
                      <Popover.Content>
                        UNDER CONSTRUCTION
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
                placeholder="Number of money to test"
                required
                min='0'
                step='0.0001'
                data-state-key='backtest.moneyToTest'
                value={symbolConfiguration.backtest.moneyToTest}
                onChange={this.handleInputChange}
              />
            </Form.Group>

            <div className='coin-info-column coin-info-column-right coin-info-column-balance'>
              <span className='coin-info-label'>Backtest Config:</span>
            </div>

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
                            {settingIcon.last_buy_price_remove_threshold}{' '}
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
                          <Form.Control
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
                          <Form.Control
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
                          <Form.Control
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
                          <Form.Control
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
                          <Form.Control
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
                          <Form.Control
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
                          <Form.Control
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
                        </Form.Group>
                        <Form.Group
                          controlId='field-sell-limit-percentage'
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
                          <Form.Control
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
                        </Form.Group>
                        <p className='form-header mb-1'>{commonStrings.sell} - {commonStrings.stop_loss}</p>
                        <Form.Group
                          controlId='field-sell-stop-loss-enabled'
                          className='mb-2'>
                          <Form.Check size='sm'>
                            <Form.Check.Input
                              type='checkbox'
                              data-state-key='sell.stopLoss.enabled'
                              checked={
                                symbolConfiguration.sell.stopLoss.enabled
                              }
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
                          <Form.Control
                            size='sm'
                            type='number'
                            placeholder={settingIcon.placeholder_enter_max_loss}
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
                          <Form.Control
                            size='sm'
                            type='number'
                            placeholder={settingIcon.placeholder_enter_max_loss}
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

          </Modal.Body>
          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={this.handleModalClose}>
              Close
            </Button>
            <Button type='submit' variant='primary' size='sm' onClick={this.handleFormSubmit}>
              Start BackTest
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
