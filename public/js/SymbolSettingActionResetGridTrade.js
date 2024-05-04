/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingActionResetGridTrade extends React.Component {
  constructor(props) {
    super(props);

    this.resetGridTrade = this.resetGridTrade.bind(this);
  }

  resetGridTrade(action) {
    const { symbolInfo } = this.props;

    this.props.handleModalClose('resetGridTrade');
    this.props.sendWebSocket('symbol-grid-trade-delete', {
      action,
      symbol: symbolInfo.symbol
    });
  }

  render() {
    return (
      <Modal
        show={this.props.showResetGridTradeModal}
        onHide={() => this.props.handleModalClose('resetGridTrade')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-danger'>⚠ Reset Grid Trade</span>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          You are about to reset the existing grid trades. If the grid trade is
          already executed, the execution history will be removed.
          <br />
          <br />
          Do you want to reset the grid trade history for the selected symbol?
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant='secondary'
            size='sm'
            onClick={() => this.props.handleModalClose('resetGridTrade')}>
            Cancel
          </Button>
          <Button
            variant='info'
            size='sm'
            onClick={() => this.resetGridTrade('archive')}>
            Archive and delete
          </Button>
          <Button
            variant='danger'
            size='sm'
            onClick={() => this.resetGridTrade('delete')}>
            Delete without archive
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}
