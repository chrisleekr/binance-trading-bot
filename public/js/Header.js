/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class Header extends React.Component {
  render() {
    return (
      <div className='app-header'>
        <div className='header-wrapper'>
          <div className='header-column header-column-title'>
            <h1 className='app-h1 m-0'>
              <img
                src='./img/binance.png'
                className='binance-img'
                alt='Binance logo'
              />{' '}
              Binance Auto Trading Bot
            </h1>
          </div>
          <div className='header-column header-column-icon'>
            <div className='header-column-icon-wrapper github-wrapper'>
              <a
                href='https://github.com/chrisleekr/binance-trading-bot'
                target='_blank'
                className='btn btn-sm p-0 pl-1 pr-1'
                rel='noreferrer'>
                <i class='fa fa-github'></i>
              </a>
            </div>

            <SettingIcon
              configuration={this.props.configuration}
              sendWebSocket={this.props.sendWebSocket}
            />
          </div>
        </div>
      </div>
    );
  }
}
