/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      configuration: {}
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);

    this.handleInputChange = this.handleInputChange.bind(this);
  }

  componentDidUpdate(nextProps) {
    // Only update configuration, when the modal is closed and different.
    if (
      this.state.showModal === false &&
      _.isEmpty(nextProps.configuration) === false &&
      _.isEqual(nextProps.configuration, this.state.configuration) === false
    ) {
      this.setState({
        configuration: nextProps.configuration
      });
    }
  }

  handleFormSubmit(e) {
    e.preventDefault();
    console.log(
      'handleFormSubmit this.state.configuration ',
      this.state.configuration
    );

    this.props.sendWebSocket('setting-update', this.state.configuration);
    this.handleModalClose();
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

    const { configuration } = this.state;

    this.setState({
      configuration: _.set(configuration, stateKey, value)
    });
  }

  render() {
    const { configuration } = this.state;
    const { symbols: selectedSymbols, supportFIATs } = configuration;

    const selectedFIATs = supportFIATs || ['USDT'];

    if (_.isEmpty(configuration)) {
      return '';
    }

    return (
      <div className='header-column-icon-wrapper setting-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 pl-1 pr-1'
          onClick={this.handleModalShow}>
          <i className='fa fa-cog'></i>
        </button>
        <Modal
          show={this.state.showModal}
          onHide={this.handleModalClose}
          size='sm'>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>Settings</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <h2 className='form-header'>Symbols</h2>
              <Form.Group>
                <Typeahead
                  multiple
                  onChange={selected => {
                    // Handle selections...
                    const { configuration } = this.state;
                    configuration.symbols = selected;
                    this.setState({ configuration });
                  }}
                  size='sm'
                  options={this.props.exchangeSymbols}
                  defaultSelected={selectedSymbols}
                  placeholder='Choose symbols to monitor...'
                />
              </Form.Group>

              <h2 className='form-header'>Support FIATs</h2>
              <Form.Group>
                <Typeahead
                  multiple
                  onChange={selected => {
                    // Handle selections...
                    const { configuration } = this.state;
                    configuration.supportFIATs = selected;
                    this.setState({ configuration });
                  }}
                  size='sm'
                  options={this.props.exchangeFIATs}
                  defaultSelected={selectedFIATs}
                  placeholder='Choose FIAT market...'
                />
              </Form.Group>

              <h2 className='form-header'>Candles</h2>
              <Form.Group controlId='field-candles-interval'>
                <Form.Label>Interval</Form.Label>
                <Form.Control
                  size='sm'
                  as='select'
                  required
                  data-state-key='candles.interval'
                  defaultValue={configuration.candles.interval}
                  onChange={this.handleInputChange}>
                  <option value='15m'>15m</option>
                  <option value='30m'>30m</option>
                  <option value='1h'>1h</option>
                  <option value='2h'>2h</option>
                  <option value='4h'>4h</option>
                  <option value='1d'>1d</option>
                </Form.Control>
                <Form.Text className='text-muted'>
                  Set candle interval for calculating lowest price.
                </Form.Text>
              </Form.Group>

              <Form.Group controlId='field-candles-limit'>
                <Form.Label>Limit</Form.Label>
                <Form.Control
                  size='sm'
                  type='number'
                  placeholder='Enter limit'
                  required
                  min='0'
                  step='1'
                  data-state-key='candles.limit'
                  defaultValue={configuration.candles.limit}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Set number of candles to retrieve for calculating lowest
                  price.
                </Form.Text>
              </Form.Group>

              <h2 className='form-header'>Buy</h2>
              <Form.Group controlId='field-maximum-purchase-amount'>
                <Form.Label>Maximum purchase amount</Form.Label>
                <Form.Control
                  size='sm'
                  type='number'
                  placeholder='Enter maximum purchase amount'
                  required
                  min='0'
                  step='1'
                  data-state-key='maxPurchaseAmount'
                  defaultValue={configuration.maxPurchaseAmount}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Set maximum purchase amount. i.e. if account has 200 USDT and
                  set as <code>100</code>, then when reach buy price, it will
                  only buy <code>100</code> worth of the coin.
                </Form.Text>
              </Form.Group>

              <h2 className='form-header'>Stop Loss Limit</h2>
              <Form.Group controlId='field-stop-loss-limit-last-buy-percentage'>
                <Form.Label>Minimum profit percentage</Form.Label>
                <Form.Control
                  size='sm'
                  type='number'
                  placeholder='Enter minimum profit percentage'
                  required
                  min='0'
                  step='0.001'
                  data-state-key='stopLossLimit.lastBuyPercentage'
                  defaultValue={configuration.stopLossLimit.lastBuyPercentage}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Set minimum profit percentage for selling. i.e. if set{' '}
                  <code>1.06</code>, minimum profit will be <code>6%</code>.
                </Form.Text>
              </Form.Group>
              <Form.Group controlId='field-stop-loss-limit-stop-percentage'>
                <Form.Label>Stop price percentage</Form.Label>
                <Form.Control
                  size='sm'
                  type='number'
                  placeholder='Enter stop price percentage'
                  required
                  min='0'
                  step='0.001'
                  data-state-key='stopLossLimit.stopPercentage'
                  defaultValue={configuration.stopLossLimit.stopPercentage}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Set percentage to calculate stop price. i.e. if set{' '}
                  <code>0.99</code> and current price <code>$106</code>, stop
                  price will be <code>$104.94</code> for stop limit order.
                </Form.Text>
              </Form.Group>

              <Form.Group controlId='field-stop-loss-limit-stop-percentage'>
                <Form.Label>Limit price percentage</Form.Label>
                <Form.Control
                  size='sm'
                  type='number'
                  placeholder='Enter limit price percentage'
                  required
                  min='0'
                  step='0.001'
                  data-state-key='stopLossLimit.limitPercentage'
                  defaultValue={configuration.stopLossLimit.limitPercentage}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Set percentage to calculate limit price. i.e. if set{' '}
                  <code>0.98</code> and current price <code>$106</code>, limit
                  price will be <code>$103.88</code> for stop limit order.
                </Form.Text>
              </Form.Group>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant='secondary'
                size='sm'
                onClick={this.handleModalClose}>
                Close
              </Button>
              <Button type='submit' variant='primary' size='sm'>
                Save Changes
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      </div>
    );
  }
}
