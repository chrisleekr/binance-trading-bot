/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

const PasswordScreen = props => {
  const [password, setPassword] = useState('');

  // Get Pass Screen translation:
  const pass_screen = props.jsonStrings.pass_screen;

  const handleFormSubmit = e => {
    e.preventDefault();

    // Send password to the backend:
    props.sendWebSocket('verify-password', {
      password,
      loginWindowMinutes:
        props.configuration.botOptions.login.loginWindowMinutes
    });
  };

  /**
   * Update the password in state.
   * @param {*} event
   */
  const handleInputChange = event => {
    const value = event.target.value;
    setPassword(value);
  };

  if (_.isEmpty(props.jsonStrings)) {
    return '';
  }

  return (
    <div className='password-wrapper'>
      <Modal show>
        <Form className='pass-screen' onSubmit={handleFormSubmit}>
          <Modal.Header className='pt-1 pb-1'>
            <Modal.Title>{pass_screen.security_screen}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <h2 className='form-header'>{pass_screen.enter_pass}</h2>
            <Form.Group controlId='field-password'>
              <Form.Label>{pass_screen._pass}</Form.Label>

              <Form.Control
                size='sm'
                type='password'
                class='form-control'
                id='inputPassword'
                autocomplete='new-password'
                placeholder='******'
                required
                data-state-key='password'
                defaultValue={password}
                onChange={handleInputChange}
              />
              <Form.Text className='text-muted'>
                {pass_screen.pass_from_env}
              </Form.Text>
            </Form.Group>
            <Button variant='secondary' onClick={handleFormSubmit}>
              {pass_screen.connect}
            </Button>
          </Modal.Body>
          <Modal.Footer></Modal.Footer>
        </Form>
      </Modal>
    </div>
  );
};
