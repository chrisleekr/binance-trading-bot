/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class LockScreen extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      loading: false,
      password: ''
    };

    this.handleFormSubmit = this.handleFormSubmit.bind(this);
    this.handlePasswordChange = this.handlePasswordChange.bind(this);
  }

  componentDidMount() {
    document.body.classList.add('app-locked');
  }

  componentWillUnmount() {
    document.body.classList.remove('app-locked');
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

        if (success === false) {
          this.setState({
            loading: false
          });
        }
        return authToken;
      })
      .catch(e => {
        console.log(e);
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
    const { loading } = this.state;

    return (
      <div className='app-lock-screen flex-column d-flex h-100 justify-content-center align-content-center text-center'>
        <div className='lock-screen-wrapper'>
          <h1 className='app-h1 my-2'>
            <img
              src='./img/binance.png'
              className='binance-img'
              alt='Binance logo'
            />{' '}
            Binance Trading Bot
          </h1>
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
      </div>
    );
  }
}
