/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class Header extends React.Component {
  render() {
    const {
      configuration,
      publicURL,
      sendWebSocket,
      exchangeSymbols,
      availableSortOptions,
      selectedSortOption,
      searchKeyword,
      setSortOption,
      setSearchKeyword
    } = this.props;

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
              Binance Trading Bot
            </h1>
          </div>
          <div className='header-column header-column-icon'>
            <FilterIcon
              availableSortOptions={availableSortOptions}
              selectedSortOption={selectedSortOption}
              searchKeyword={searchKeyword}
              setSortOption={setSortOption}
              setSearchKeyword={setSearchKeyword}
            />

            <div className='header-column-icon-wrapper github-wrapper'>
              <a
                href='https://github.com/chrisleekr/binance-trading-bot'
                target='_blank'
                className='btn btn-sm p-0 pl-1 pr-1'
                rel='noreferrer'>
                <i className='fab fa-github'></i>
              </a>
            </div>

            {_.isEmpty(publicURL) === false ? (
              <div className='header-column-icon-wrapper public-url-wrapper'>
                <a
                  href={publicURL}
                  className='btn btn-sm btn-link p-0 pl-1 pr-1'
                  target='_blank'
                  rel='noreferrer'
                  title={publicURL}>
                  <i className='fas fa-link'></i>
                </a>
              </div>
            ) : (
              ''
            )}
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
