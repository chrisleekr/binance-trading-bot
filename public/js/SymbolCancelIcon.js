/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */
class SymbolCancelIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      showModal: false,
      isCancelled: false
    };

    this.handleCancel = this.handleCancel.bind(this);
  }

  handleCancel(e) {
    e.preventDefault();
    const { order } = this.props;
    this.props.sendWebSocket('cancel-order', {
      symbol: this.props.symbol,
      order
    });

    this.setState({ isCancelled: true });
  }

  render() {
    const { isCancelled } = this.state;
    return (
      <div className='header-column-icon-wrapper symbol-delete-wrapper'>
        {isCancelled ? (
          ''
        ) : (
          <button
            type='button'
            className='btn btn-sm btn-link p-0 pl-1 btn-cancel-order'
            onClick={this.handleCancel}>
            <i className='fa fa-times-circle'></i>
          </button>
        )}
      </div>
    );
  }
}
