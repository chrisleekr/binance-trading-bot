/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolDeleteIcon extends React.Component {
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

  canDelete() {
    const { symbolInfo } = this.props;

    if (
      symbolInfo.buy.openOrders.length === 0 &&
      symbolInfo.sell.lastBuyPrice <= 0 &&
      symbolInfo.sell.openOrders.length === 0
    ) {
      return true;
    }

    return false;
  }

  handleDelete(e) {
    e.preventDefault();
    const { symbolInfo } = this.props;
    this.props.sendWebSocket('symbol-delete', {
      symbolInfo
    });

    this.handleModalClose();
  }

  render() {
    if (this.canDelete()) {
      const { symbolInfo } = this.props;
      return (
        <div className='header-column-icon-wrapper symbol-delete-wrapper'>
          <button
            type='button'
            className='btn btn-sm btn-link p-0 pl-1'
            onClick={this.handleModalShow}>
            <i className='fa fa-times-circle'></i>
          </button>

          <Modal show={this.state.showModal} onHide={this.handleModalClose}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>Remove Symbol - {symbolInfo.symbol}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              Are you sure to remove this symbol from the cache?
              <br />
              Note that it is simply removing cache values for the symbol.
              <br />
              If the symbol is still monitoring, then it will show up again.
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
                variant='danger'
                size='sm'
                onClick={this.handleDelete}>
                Remove
              </Button>
            </Modal.Footer>
          </Modal>
        </div>
      );
    }

    return '';
  }
}
