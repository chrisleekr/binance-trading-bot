/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconActions extends React.Component {
  constructor(props) {
    super(props);

    this.modalToStateMap = {
      'backup-confirm': 'showBackupConfirmModal',
      'restore-confirm': 'showRestoreConfirmModal',
      'restore-success': 'showRestoreSuccessModal'
    };

    this.state = {
      showBackupConfirmModal: false,
      showRestoreConfirmModal: false,
      showRestoreSuccessModal: false
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
  }

  handleModalShow(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: true
    });
  }

  handleModalClose(modal) {
    this.setState({
      [this.modalToStateMap[modal]]: false
    });
  }

  render() {
    return (
      <React.Fragment>
        <SettingIconActionBackupConfirmModal
          showBackupConfirmModal={this.state.showBackupConfirmModal}
          handleModalClose={this.handleModalClose}
        />

        <SettingIconActionRestoreConfirmModal
          showRestoreConfirmModal={this.state.showRestoreConfirmModal}
          handleModalShow={this.handleModalShow}
          handleModalClose={this.handleModalClose}
        />

        <SettingIconActionRestoreSuccessModal
          showRestoreSuccessModal={this.state.showRestoreSuccessModal}
          handleModalClose={this.handleModalClose}
        />

        <Accordion defaultActiveKey='0'>
          <Card className='mt-1'>
            <Card.Header className='px-2 py-1'>
              <Accordion.Toggle
                as={Button}
                variant='link'
                eventKey='0'
                className='p-0 fs-7 text-uppercase'>
                Actions
              </Accordion.Toggle>
            </Card.Header>
            <Accordion.Collapse eventKey='0'>
              <Card.Body className='px-2 py-2'>
                <div className='row'>
                  <div className='col-12'>
                    <Button
                      variant='primary'
                      size='sm'
                      type='button'
                      className='mr-2'
                      onClick={() => this.handleModalShow('backup-confirm')}>
                      Backup Database
                    </Button>

                    <Button
                      variant='primary'
                      size='sm'
                      type='button'
                      onClick={() => this.handleModalShow('restore-confirm')}>
                      Restore Database
                    </Button>
                  </div>
                </div>
              </Card.Body>
            </Accordion.Collapse>
          </Card>
        </Accordion>
      </React.Fragment>
    );
  }
}
