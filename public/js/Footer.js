/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class Footer extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      currentVersion: ''
    };
  }

  componentDidMount() {
    const self = this;
    // Make a request for a user with a given ID
    axios
      .get(
        'https://raw.githubusercontent.com/chrisleekr/binance-trading-bot/master/package.json'
      )
      .then(response => {
        // handle success
        self.setState({
          currentVersion: response.data.version
        });
      });
  }

  render() {
    const { packageVersion, gitHash } = this.props;
    const { currentVersion } = this.state;

    if (!packageVersion) {
      return '';
    }

    return (
      <div className='app-footer'>
        <div className='footer-wrapper'>
          <div className='footer-column mr-1'>
            Running Version: <span className='ml-1'>v{packageVersion}</span> (
            {gitHash})
          </div>
          <div className='footer-column'>
            Latest Version:
            <a
              href='https://github.com/chrisleekr/binance-trading-bot/releases'
              target='_blank'
              className='ml-1'
              rel='noreferrer'>
              v{currentVersion}
            </a>
          </div>
        </div>
      </div>
    );
  }
}
