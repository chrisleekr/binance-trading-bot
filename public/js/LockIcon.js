/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class LockIcon extends React.Component {
  constructor(props) {
    super(props);

    this.handleLock = this.handleLock.bind(this);
  }

  handleLock() {
    localStorage.setItem('authToken', '');
  }

  render() {
    const { isAuthenticated } = this.props;
    if (isAuthenticated === false) {
      return '';
    }

    return (
      <div className='header-column-icon-wrapper lock-wrapper'>
        <button
          type='button'
          className='btn btn-sm btn-link p-0 pl-1'
          onClick={this.handleLock}
          title='Lock the bot'>
          <i className='fas fa-lock'></i>
        </button>
      </div>
    );
  }
}
