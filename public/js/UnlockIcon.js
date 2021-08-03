/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class UnlockIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      loading: false,
      password: ''
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);

    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handlePasswordChange = this.handlePasswordChange.bind(this);
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

  async handleFormSubmit(e) {
    e.preventDefault();

    const { password } = this.state;
    this.setState({
      loading: true
    });

    const authToken = await axios
      .post('/auth', { password })
      .then(response => {
        // handle success
        const {
          data: {
            success,
            data: { authToken }
          }
        } = response;

        if (success === true) {
          this.handleModalClose();
        }

        return authToken;
      })
      .catch(e => {
        console.log(e);
      })
      .finally(() => {
        this.setState({
          loading: false
        });
      });

    localStorage.setItem('authToken', authToken);
  }

  handlePasswordChange(e) {
    const target = e.target;
    const value = target.value;

    this.setState({
      password: value
    });
  }

  render() {
    const { isAuthenticated } = this.props;
    if (isAuthenticated === true) {
      return '';
    }

    const { loading, password } = this.state;

    return (
      <div className='header-column-icon-wrapper unlock-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 pl-1'
          onClick={this.handleModalShow}
          title='Unlock the bot'>
          <i className='fas fa-unlock-alt'></i>
        </button>

        <Modal show={this.state.showModal} onHide={this.handleModalClose}>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>Unlock</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <div className='lock-screen-wrapper w-100'>
              {loading ? (
                <div className='text-center w-100'>
                  <Spinner animation='border' role='status'>
                    <span className='sr-only'>Loading...</span>
                  </Spinner>
                </div>
              ) : (
                <Form onSubmit={this.handleFormSubmit}>
                  <InputGroup>
                    <InputGroup.Prepend>
                      <InputGroup.Text>
                        <i className='fas fa-lock'></i>
                      </InputGroup.Text>
                    </InputGroup.Prepend>

                    <Form.Control
                      type='password'
                      placeholder='Enter your password'
                      required
                      defaultValue={password}
                      onChange={this.handlePasswordChange}
                    />

                    <InputGroup.Append>
                      <InputGroup.Text>
                        <button
                          type='submit'
                          className='btn btn-sm btn-link p-0 ml-1'>
                          <i className='fas fa-arrow-right'></i>
                        </button>
                      </InputGroup.Text>
                    </InputGroup.Append>
                  </InputGroup>
                </Form>
              )}
            </div>
          </Modal.Body>

          <Modal.Footer>
            {loading === false ? (
              <React.Fragment>
                <Button
                  variant='secondary'
                  size='sm'
                  onClick={this.handleModalClose}>
                  Close
                </Button>
                <Button
                  type='button'
                  variant='primary'
                  size='sm'
                  onClick={this.handleFormSubmit}>
                  Unlock
                </Button>
              </React.Fragment>
            ) : (
              ''
            )}
          </Modal.Footer>
        </Modal>
      </div>
    );
  }
}
