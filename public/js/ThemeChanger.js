/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class ThemeChanger extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      configuration: {}
    }
    this.themeChange = this.themeChange.bind(this);
  }

  themeChange() {
    let newConfig = this.props.configuration;

    if (newConfig.botOptions.theme === 'theme-dark') {
      document.documentElement.className = 'theme-light';
      newConfig.botOptions.theme = 'theme-light';
    } else {
      document.documentElement.className = 'theme-dark';
      newConfig.botOptions.theme = 'theme-dark';
    }

    this.props.sendWebSocket('setting-update', {
      ...newConfig
    });
  }

  render() {

    const { configuration: { botOptions } } = this.props;

    const theme = botOptions.theme;

    if (theme !== document.documentElement.className) {
      document.documentElement.className = theme;
    }

    return (
      <div className='header-column-icon-wrapper setting-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 pl-1 pr-1'
          onClick={this.themeChange}>
          <i className='gg-color-picker'></i>
        </button>
      </div>
    );
  }
}
