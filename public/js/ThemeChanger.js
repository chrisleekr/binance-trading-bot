/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class ThemeChanger extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      lastThemeSet: 'theme-dark'
    }

    this.themeChange = this.themeChange.bind(this);
  }

  themeChange() {
    const { configuration: { botOptions } } = this.props;

    if (botOptions.theme === 'theme-dark') {
      document.documentElement.className = 'theme-light';
      botOptions.theme = 'theme-light';
    } else {
      document.documentElement.className = 'theme-dark';
      botOptions.theme = 'theme-dark';
    }

    console.log(botOptions)
  }

  render() {

    const { configuration: { botOptions } } = this.props;

    const { lastThemeSet } = this.state;

    const theme = botOptions.theme;

    if (theme !== lastThemeSet) {
      document.documentElement.className = theme;
      this.state = {
        lastThemeSet: theme
      }
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
