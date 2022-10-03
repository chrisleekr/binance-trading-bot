/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SettingIconActionRestoreConfirmModal extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      loading: false,
      selectedFiles: undefined,
      currentFile: undefined,
      progress: 0,
      message: '',
      stderr: '',
      stdout: ''
    };

    this.onDrop = this.onDrop.bind(this);
    this.triggerRestore = this.triggerRestore.bind(this);
  }

  onDrop(files) {
    if (files.length > 0) {
      this.setState({ selectedFiles: files });
    }
  }

  triggerRestore() {
    const authToken = localStorage.getItem('authToken') || '';

    const currentFile = this.state.selectedFiles[0];

    this.setState({
      loading: true,
      progress: 0,
      currentFile
    });

    let formdata = new FormData();
    formdata.append('archive', currentFile);

    return axios
      .post('/restore/', formdata, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'X-AUTH-TOKEN': authToken
        },
        onUploadProgress: event => {
          this.setState({
            progress: Math.round((100 * event.loaded) / event.total)
          });
        }
      })
      .then(response => {
        // If it received any response, then it means the restore is failed.
        // Show the response.
        // data: {code: 1, stdout: "",…}
        // code: 1
        // stderr: "2022-08-30T22:17:47.718+0000\tFailed: gzip: invalid header\n2022-08-30T22:17:47.718+0000\t0 document(s) restored successfully. 0 document(s) failed to restore.\n"
        // stdout: ""
        // message: "Restore failed"
        // status: 500
        // success: false

        const {
          message,
          data: { stderr, stdout }
        } = response.data;
        this.setState({
          loading: false,
          message,
          stderr,
          stdout
        });
      })
      .catch(e => {
        // If it received the error with ERR_NETWORK, then the restoration is succeed.
        console.error(e);
        if (e.code === 'ERR_NETWORK') {
          console.log('It means, restore is succeed.');
          this.props.handleModalShow('restore-success');
        }
        this.props.handleModalClose('restore-confirm');
        this.setState({
          loading: false
        });
      });
  }

  render() {
    const {
      loading,
      selectedFiles,
      currentFile,
      progress,
      message,
      stderr,
      stdout
    } = this.state;

    return (
      <Modal
        show={this.props.showRestoreConfirmModal}
        onHide={() => this.props.handleModalClose('restore-confirm')}
        size='md'>
        <Modal.Header className='pt-1 pb-1'>
          <Modal.Title>
            <span className='text-primary'>
              <i className='fas fa-cloud-upload-alt'></i>&nbsp; Restore database
            </span>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Warning: You are about to restore database. Restoring database will be
          wipe current data. So please be careful.
          <br />
          <br />
          Please drag and drop the backup file or click to select backup file.
          i.e. <code>binance-bot-backup.archive</code>
          <br />
          <br />
          <Dropzone
            onDrop={this.onDrop}
            multiple={false}
            accept={{
              'application/octet-stream': ['.archive']
            }}>
            {({ getRootProps, getInputProps }) => (
              <section className='container'>
                <div {...getRootProps({ className: 'dropzone' })}>
                  <input {...getInputProps()} />
                  {selectedFiles && selectedFiles[0].name ? (
                    <div className='selected-file'>
                      {selectedFiles && selectedFiles[0].name}
                    </div>
                  ) : (
                    <p>
                      Drag 'n' drop the backup archive file here
                      <br /> or click to select the backup archive file
                    </p>
                  )}
                </div>
              </section>
            )}
          </Dropzone>
          And click "Upload & Restore" button.
          <br />
          <br />
          Once the backup file is uploaded, the database will replace with the
          uploaded archive. And then flush all cache.
          <br />
          <br />
          Note that the logs will not be restored. If your database is large,
          then the bot may be slow down during the restore.
          <br />
          <br />
          Once the restore is completed, then it will perform cold reboot by
          restarting the container.
          {currentFile && (
            <div className='progress mb-3'>
              <div
                className='progress-bar progress-bar-info progress-bar-striped'
                role='progressbar'
                aria-valuenow={progress}
                aria-valuemin='0'
                aria-valuemax='100'
                style={{ width: progress + '%' }}>
                {progress}%
              </div>
            </div>
          )}
          {message ? (
            <div className='message-wrapper'>
              <p className='text-danger'>{message}</p>
              {stderr || stdout ? (
                <textarea
                  className='w-100'
                  style={{ height: '500px' }}
                  value={`${stderr || ''}${stdout || ''}`}
                  readOnly></textarea>
              ) : (
                ''
              )}
            </div>
          ) : (
            ''
          )}
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant='secondary'
            size='sm'
            onClick={() => this.props.handleModalClose('restore-confirm')}>
            Cancel
          </Button>
          <Button
            variant='success'
            size='sm'
            disabled={loading || !selectedFiles}
            onClick={() => this.triggerRestore()}>
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
            Upload &amp; Restore
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }
}
