/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class ThemeChanger extends React.Component {
  constructor(props) {
    super(props);

    this.themeChange = this.themeChange.bind(this);
  }

  themeChange() {
    if (localStorage.getItem('theme') === 'theme-dark') {
      localStorage.setItem('theme', 'theme-light');
      document.documentElement.className = 'theme-light';
    } else {
      localStorage.setItem('theme', 'theme-dark');
      document.documentElement.className = 'theme-dark';
    }
  }

  render() {

    if (localStorage.getItem('theme') === 'theme-dark') {
      localStorage.setItem('theme', 'theme-dark');
      document.documentElement.className = 'theme-dark';
    } else {
      localStorage.setItem('theme', 'theme-light');
      document.documentElement.className = 'theme-light';
    }

    return (
      <div className='header-column-icon-wrapper setting-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 pl-1 btn-cancel-order'
          onClick={this.themeChange}>
          <i className='fa fa-times-circle'></i>
        </button>
      </div>
    );
  }
}
