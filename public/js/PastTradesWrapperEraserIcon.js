/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class PastTradesWrapperEraserIcon extends React.Component {
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
    this.props.sendWebSocket('past-trades-erase');

    this.handleModalClose();
  }

  render() {
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
            <Modal.Title>Erase Past Trades </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            It will erase your past trades. It can't be undone.
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant='secondary'
              size='sm'
              onClick={this.handleModalClose}>
              Cancel
            </Button>
            <Button
              type='button'
              variant='danger'
              size='sm'
              onClick={this.handleDelete}>
              Erase
            </Button>
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
