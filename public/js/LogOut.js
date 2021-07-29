// eslint-disable-next-line no-unused-vars
const LogOut = ({ sendWebSocket }) => {
  const handleClick = () => {
    if (window.confirm('Disconnect?')) {
      sendWebSocket('disconnect');
    }
  };

  return (
    <div className='header-column-icon-wrapper setting-wrapper'>
      <button
        type='button'
        className='btn btn-sm btn-link p-0 pl-1 pr-1'
        onClick={handleClick}>
        <i class='fa fa-power-off' aria-hidden='true'></i>
      </button>
    </div>
  );
};
