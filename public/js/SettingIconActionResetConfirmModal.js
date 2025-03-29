/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconActionResetConfirmModal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      resetting: false
    };
    this.triggerReset = this.triggerReset.bind(this);
  }

  triggerReset() {
    const authToken = localStorage.getItem('authToken') || '';

    this.setState({
      resetting: true
    });

    return axios
      .get('/reset-config', {
        headers: {
          'X-AUTH-TOKEN': authToken
        }
      })
      .then(response => {
        this.setState({
          resetting: false
        });
        if (response.status === 200) {
          console.log('Reset success.');
          this.props.handleModalShow('reset-success');
        }
        this.props.handleModalClose('restore-confirm');
      })
      .catch(e => console.error(e));
  }

  render() {
    const { resetting } = this.state;

    return (
      <Modal
        show={this.props.showResetConfirmModal}
        onHide={() => this.props.handleModalClose('reset-confirm')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-primary'>
              <i className='fas fa-cloud-upload-alt'></i>&nbsp; Reset config
            </span>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Warning: You are about to reset the configuration. Resetting the
          config will undo any changes you may have made.
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant='secondary'
            size='sm'
            onClick={() => this.props.handleModalClose('reset-confirm')}>
            Cancel
          </Button>
          <Button
            variant='success'
            size='sm'
            disabled={resetting}
            onClick={() => this.triggerReset()}>
            {resetting ? (
              <Spinner
                animation='border'
                role='status'
                className='mr-2'
                style={{ width: '1rem', height: '1rem' }}>
                <span className='sr-only'>Resetting...</span>
              </Spinner>
            ) : (
              ''
            )}
            Reset
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}
