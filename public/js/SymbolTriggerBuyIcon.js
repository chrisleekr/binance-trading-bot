/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolTriggerBuyIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);

    this.handleDelete = this.handleDelete.bind(this);
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

  handleDelete(e) {
    e.preventDefault();
    const { symbol } = this.props;
    this.props.sendWebSocket('symbol-trigger-buy', {
      symbol
    });

    this.handleModalClose();
  }

  render() {
    const { symbol, className } = this.props;
    return (
      <span
        className={
          'header-column-icon-wrapper symbol-trigger-buy-wrapper ' + className
        }>
        <button
          type='button'
          className='btn btn-sm btn-trigger-grid-trade mr-1'
          onClick={this.handleModalShow}>
          <i className='fas fa-bolt'></i> Trigger
        </button>

        <Modal show={this.state.showModal} onHide={this.handleModalClose}>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>Trigger Buy Action - {symbol}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            Are you sure to trigger a buy action for this symbol?
            <br />
            <br />
            The bot will place a STOP-LOSS-LIMIT order for the currently active
            grid trade.
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={this.handleModalClose}>
              Close
            </Button>
            <Button
              type='button'
              variant='success'
              size='sm'
              onClick={this.handleDelete}>
              Trigger Buy
            </Button>
          </Modal.Footer>
        </Modal>
      </span>
    );
  }
}
