/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class Header extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      searchFocused: false
    };

    this.setSearchFocused = this.setSearchFocused.bind(this);
  }

  setSearchFocused(searchFocused) {
    this.setState({
      searchFocused
    });
  }

  render() {
    const { configuration, sendWebSocket, exchangeSymbols, setSearchKeyword } =
      this.props;

    const { searchFocused } = this.state;

    return (
      <div className='app-header'>
        <div
          className={`header-wrapper ${
            searchFocused ? 'search-focused' : 'search-not-focused'
          }`}>
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
            <SearchIcon
              setSearchFocused={this.setSearchFocused}
              setSearchKeyword={setSearchKeyword}
            />
            {_.isEmpty(configuration) === false ? (
              <SettingIcon
                exchangeSymbols={exchangeSymbols}
                configuration={configuration}
                sendWebSocket={sendWebSocket}
              />
            ) : (
              ''
            )}
          </div>
        </div>
      </div>
    );
  }
}
