/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class SearchIcon extends React.Component {
  constructor(props) {
    super(props);
    this.handleInputChange = this.handleInputChange.bind(this);
    this.handleInputFocus = this.handleInputFocus.bind(this);
    this.handleInputBlur = this.handleInputBlur.bind(this);
  }

  handleInputFocus(_event) {
    this.props.setSearchFocused(true);
  }
  handleInputBlur(_event) {
    this.props.setSearchFocused(false);
  }

  handleInputChange(event) {
    const value = event.target.value;
    this.props.setSearchKeyword(value);
  }

  render() {
    return (
      <div className='header-column-icon-wrapper search-box-wrapper'>
        <input
          id='search-box'
          type='text'
          className='search-box'
          onFocus={this.handleInputFocus}
          onBlur={this.handleInputBlur}
          onChange={this.handleInputChange}
        />
        <label htmlFor='search-box'>
          <span className='fa fa-search search-icon'></span>
        </label>
      </div>
    );
  }
}
