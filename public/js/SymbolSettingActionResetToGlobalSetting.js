/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolSettingActionResetToGlobalSetting extends React.Component {
  constructor(props) {
    super(props);

    this.resetToGlobalConfiguration =
      this.resetToGlobalConfiguration.bind(this);
  }

  resetToGlobalConfiguration() {
    const { symbolInfo } = this.props;

    this.props.handleModalClose('resetGlobalSetting');

    this.props.sendWebSocket('symbol-setting-delete', symbolInfo);
  }

  render() {
    return (
      <Modal
        show={this.props.showResetToGlobalSettingModal}
        onHide={() => this.props.handleModalClose('resetGlobalSetting')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-danger'>⚠ Reset to Global Setting</span>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Warning: You are about to reset the symbol setting to the global
          setting.
          <br />
          <br />
          Do you want to delete current symbol setting?
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant='secondary'
            size='sm'
            onClick={() => this.props.handleModalClose('resetGlobalSetting')}>
            Cancel
          </Button>
          <Button
            variant='success'
            size='sm'
            onClick={() => this.resetToGlobalConfiguration()}>
            Yes
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}
