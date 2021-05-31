/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolEditLastBuyPriceIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      symbolInfo: {}
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
      _.isEmpty(nextProps.symbolInfo) === false &&
      _.isEqual(nextProps.symbolInfo, this.state.symbolInfo) === false
    ) {
      this.setState({
        symbolInfo: nextProps.symbolInfo
      });
    }
  }

  handleFormSubmit(e) {
    e.preventDefault();

    const {
      symbol,
      sell: { lastBuyPrice }
    } = this.state.symbolInfo;

    this.props.sendWebSocket('symbol-update-last-buy-price', {
      symbol,
      sell: { lastBuyPrice }
    });
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

    const { symbolInfo } = this.state;

    this.setState({
      symbolInfo: _.set(symbolInfo, stateKey, value)
    });
  }

  render() {
    const { symbolInfo } = this.state;

    if (_.isEmpty(symbolInfo)) {
      return '';
    }

    return (
      <div className='symbol-edit-last-buy-price-icon-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0'
          onClick={this.handleModalShow}>
          <i className='fa fa-edit'></i>
        </button>
        <Modal show={this.state.showModal} onHide={this.handleModalClose}>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>
                Edit Last Buy Price for {symbolInfo.symbol}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <h2 className='form-header'>Sell Signal</h2>
              <Form.Group controlId='field-candles-interval'>
                <Form.Label>Last Buy Price</Form.Label>
                <Form.Control
                  size='sm'
                  type='number'
                  placeholder='Enter last buy price'
                  required
                  min='0'
                  step='0.00000001'
                  data-state-key='sell.lastBuyPrice'
                  defaultValue={symbolInfo.sell.lastBuyPrice}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Set/modify the last buy price of the symbol.
                  <br />
                  <br />
                  If the bot purchased the coin, then the last buy price will
                  automatically set.
                  <br />
                  <br />
                  If you purchased the coin manually, then you can set the last
                  buy price to allow the bot to sell at the expected price.
                  <br />
                  <br />
                  Once the last buy price is set, then the bot will start
                  monitoring the sell signal.
                  <br />
                  <br />
                  If you want to remove the last buy price, simply enter{' '}
                  <code>0</code>.
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
