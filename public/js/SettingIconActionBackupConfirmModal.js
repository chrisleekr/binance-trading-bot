/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconActionBackupConfirmModal extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      loading: false
    };

    this.triggerBackup = this.triggerBackup.bind(this);
  }

  triggerBackup() {
    const authToken = localStorage.getItem('authToken') || '';

    this.setState({
      loading: true
    });

    return axios
      .get('/backup/', {
        responseType: 'arraybuffer',
        headers: {
          'X-AUTH-TOKEN': authToken,
          'Content-Type': 'application/gzip'
        }
      })
      .then(response => {
        const contentDisposition = response.headers['content-disposition'];
        let fileName = 'binance-bot.archive';
        if (contentDisposition) {
          const fileNameMatch = contentDisposition.match(/filename="(.+)"/);
          if (fileNameMatch.length === 2) fileName = fileNameMatch[1];
        }

        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', fileName);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      })
      .catch(e => {
        console.error(e);
      })
      .finally(() => {
        this.props.handleModalClose('backup-confirm');
        this.setState({
          loading: false
        });
      });
  }

  render() {
    const { loading } = this.state;

    return (
      <Modal
        show={this.props.showBackupConfirmModal}
        onHide={() => this.props.handleModalClose('backup-confirm')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-primary'>
              <i className='fas fa-cloud-download-alt'></i>&nbsp; Backup
              database
            </span>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Warning: You are about to backup database. If your database is large,
          then the bot may be slow down during the backup.
          <br />
          <br />
          Note that the logs will be excluded from the backup to reduce the
          size. <br />
          <br />
          Once the backup is completed, then it will be downloading the archive
          file. You can use the archive file to restore later.
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant='secondary'
            size='sm'
            onClick={() => this.props.handleModalClose('backup-confirm')}>
            Cancel
          </Button>
          <Button
            variant='success'
            size='sm'
            disabled={loading}
            onClick={() => this.triggerBackup()}>
            {loading ? (
              <Spinner
                animation='border'
                role='status'
                className='mr-2'
                style={{ width: '1rem', height: '1rem' }}>
                <span className='sr-only'>Loading...</span>
              </Spinner>
            ) : (
              ''
            )}
            Backup &amp; Download
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}
