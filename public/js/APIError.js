/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class APIError extends React.Component {
  componentDidMount() {
    document.body.classList.add('app-locked');
  }

  componentWillUnmount() {
    document.body.classList.remove('app-locked');
  }

  render() {
    return (
      <div className='app-lock-screen flex-column d-flex h-100 justify-content-center align-content-center'>
        <div className='lock-screen-wrapper d-flex flex-column justify-content-center'>
          <h1 className='app-h1 my-2 mb-3 text-center'>
            <img
              src='./img/binance.png'
              className='binance-img'
              alt='Binance logo'
            />{' '}
            Binance Trading Bot
          </h1>

          <h3 className='text-danger'>
            Failed to load your account information.
          </h3>

          <div className='text-left'>
            <p>
              You are seeing this error message because of one of the following
              situations:
              <br />
              <ul>
                <li>You are using TestNet API/Secret for Live Binance.</li>
                <li>You are using Live API/Secret for TestNet Binance.</li>
                <li>Your API key is revoked/deleted.</li>
                <li>
                  Your API key is not permitted to "Enable Reading" and "Enable
                  Spot & Margin Trading".
                </li>
                <li>
                  Your API key is restricted to trusted IP, and your bot is
                  located not in trusted IP.
                </li>
              </ul>
            </p>
            <p>
              Please read the following document carefully, update your
              configuration. And then try to launch the bot again.
              <br />
              <a
                href='https://github.com/chrisleekr/binance-trading-bot/wiki/Install#how-to-install'
                target='_blank'
                rel='noreferrer'>
                https://github.com/chrisleekr/binance-trading-bot/wiki/Install#how-to-install
              </a>
              <br />
              <br />
              If the issue persists after confirming the API key/secret, please
              open a new issue in Github.
            </p>
          </div>
        </div>
      </div>
    );
  }
}
