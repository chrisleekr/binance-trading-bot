/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class PasswordScreen extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: true,
      password: ''
    };

    this.handleModalShow = this.handleModalShow.bind(this);
    this.handleModalClose = this.handleModalClose.bind(this);
    this.handleFormSubmit = this.handleFormSubmit.bind(this);

    this.handleInputChange = this.handleInputChange.bind(this);
  }

  handleFormSubmit(e) {
    e.preventDefault();

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

  handleInputChange(event) {
    const value = event.target.value;
    this.state.password = value;

    const savedPassword = this.props.password;
    const splittedTypedPassword = Array.from(this.state.password);
    let verifiedLength = 0;

    try {
      for (let indexToVerify = 0; indexToVerify < savedPassword.length; indexToVerify++) {
        if (splittedTypedPassword.length > indexToVerify) {
          if (savedPassword[indexToVerify] === splittedTypedPassword[indexToVerify]) {
            verifiedLength++;
          }
        }
      }
    } finally {
      if (verifiedLength === savedPassword.length) {
        this.handleModalClose();
        localStorage.setItem('login', 'success');
      }
    }
  }

  render() {
    const { password } = this.state;
    if (localStorage.getItem('login') === 'success') {
      return '';
    }
    return (
      <div className='password-wrapper'>
        <Modal show={this.state.showModal}>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>
                Security Screen
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <h2 className='form-header'>Enter your password</h2>
              <Form.Group controlId='field-password'>
                <Form.Label>Password</Form.Label>
                <Form.Control
                  size='sm'
                  type="password"
                  class="form-control"
                  id="inputPassword"
                  placeholder='******'
                  required
                  data-state-key='password'
                  defaultValue={password}
                  onChange={this.handleInputChange}
                />
                <Form.Text className='text-muted'>
                  Define password saved in .env file.
                </Form.Text>
              </Form.Group>
            </Modal.Body>
            <Modal.Footer>
            </Modal.Footer>
          </Form>
        </Modal>
      </div>
    );
  }
}
