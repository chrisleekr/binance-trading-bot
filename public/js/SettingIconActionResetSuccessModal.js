/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconActionResetSuccessModal extends React.Component {
  refreshWindow() {
    window.location.reload(true);
  }

  render() {
    return (
      <Modal
        show={this.props.showResetSuccessModal}
        onHide={() => this.props.handleModalClose('reset-success')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-primary'>
              <i className='fas fa-cloud-upload-alt'></i>&nbsp; Successfully
              reset the configuration
            </span>
          </Modal.Title>
        </Modal.Header>

        <Modal.Footer>
          <Button
            variant='success'
            size='sm'
            onClick={() => this.refreshWindow()}>
            Refresh
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}
