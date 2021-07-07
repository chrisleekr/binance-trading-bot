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

    const { configuration } = this.props;
    const typedPassword = {
      pass: Array.from(value),
      config: configuration
    };
    this.props.sendWebSocket('verify-password', {
      typedPassword
    });
  }

  render() {
    const { password } = this.state;
    const { jsonStrings: { pass_screen } } = this.props;

    if (_.isEmpty(this.props.jsonStrings)) {
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
