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

  verifyPassword(savedPassword, typedPassword) {
    let verifiedLength = 0;

    //Verifies char by char if the password is equal.
    try {
      for (let indexToVerify = 0; indexToVerify < savedPassword.length; indexToVerify++) {
        if (typedPassword.length > indexToVerify) {
          if (savedPassword[indexToVerify] === typedPassword[indexToVerify]) {
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

  handleInputChange(event) {
    const value = event.target.value;
    this.state.password = value;

    //Retrieve passwords.
    const savedPassword = this.props.password;
    const typedPassword = Array.from(this.state.password);

    //Try to unlock.
    this.verifyPassword(savedPassword, typedPassword);
  }

  render() {
    const { password } = this.state;
    const { jsonStrings: { pass_screen } } = this.props;

    if (_.isEmpty(this.props.jsonStrings)) {
      return '';
    }

    if (localStorage.getItem('login') === 'success') {
      return '';
    }

    return (
      <div className='password-wrapper'>
        <Modal show={this.state.showModal}>
          <Form onSubmit={this.handleFormSubmit}>
            <Modal.Header className='pt-1 pb-1'>
              <Modal.Title>
                {pass_screen.security_screen}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <h2 className='form-header'>{pass_screen.enter_pass}</h2>
              <Form.Group controlId='field-password'>
                <Form.Label>{pass_screen._pass}</Form.Label>
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
                  {pass_screen.pass_from_env}
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
