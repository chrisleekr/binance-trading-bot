/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class ManualTradeIcon extends React.Component {
  constructor(props) {
    super(props);

    this.initialOrder = {
      side: null,
      buy: {
        type: 'market', // only support market
        marketType: 'total', // only support total
        quoteOrderQty: 0, // market total
        isValid: false
      },
      sell: {
        type: 'market', // only support market
        marketType: 'amount', // only support amount percentage
        marketQuantityPercentage: 0, // market amount percentage
        isValid: false
      }
    };

    this.state = {
      showModal: false,
      lastCandle: null,
      order: _.cloneDeep(this.initialOrder)
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleClick = this.handleClick.bind(this);
  }

  handleModalShow() {
    const newOrder = _.cloneDeep(this.initialOrder);

    this.setState({
      showModal: true,
      order: newOrder
    });
  }

  handleModalClose() {
    this.setState({
      showModal: false
    });
  }

  handleClick(e) {
    e.target.select();
  }

  handleInputChange(event) {
    const target = event.target;
    const value =
      target.type === 'button'
        ? target.getAttribute('data-state-value')
        : target.type === 'checkbox'
        ? target.checked
        : target.type === 'number'
        ? +target.value
        : target.value;
    const stateKey = target.getAttribute('data-state-key');

    const { order } = this.state;

    const newOrder = _.set(order, stateKey, value);
    this.setState({
      order: newOrder
    });
  }

  handleFormSubmit(e) {
    e.preventDefault();
    console.log('handleFormSubmit', this.state.order);

    this.handleModalClose();

    this.props.sendWebSocket('manual-trade-all-symbols', {
      order: this.state.order
    });
  }

  render() {
    const { showModal } = this.state;

    return (
      <div className='coin-info-manual-trade-wrapper'>
        <div className='coin-info-column coin-info-column-manual-trade d-flex flex-row justify-content-start align-content-between border-bottom-0 mb-0 pb-0'>
          <button
            type='button'
            className='btn btn-sm btn-manual-trade mr-1'
            onClick={() => this.handleModalShow()}>
            <i className='fa fa-shopping-bag'></i> Trade All
          </button>
        </div>
        <Modal
          show={showModal}
          onHide={() => this.handleModalClose()}
          backdrop='static'
          size='xl'>
          <Modal.Header closeButton className='pt-1 pb-1'>
            <Modal.Title>Manual Trade for all symbols</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className='d-block text-muted mb-2'></p>
          </Modal.Body>
        </Modal>
      </div>
    );
  }
}
