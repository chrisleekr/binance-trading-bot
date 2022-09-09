/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconActionRestoreSuccessModal extends React.Component {
  refreshWindow() {
    window.location.reload(true);
  }

  render() {
    return (
      <Modal
        show={this.props.showRestoreSuccessModal}
        onHide={() => this.props.handleModalClose('restore-success')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-primary'>
              <i className='fas fa-cloud-upload-alt'></i>&nbsp; Successfully
              restored
            </span>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          As the bot restarted, it looks like the restoration was completed
          successfully. <br />
          <br />
          You can click the "Refresh" button to see the restored data.
        </Modal.Body>

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
