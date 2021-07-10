/* eslint-disable no-unused-vars */
/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

class SortIcon extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      sortType: 'default'
    };

    this.handleInputChange = this.handleInputChange.bind(this);
  }

  handleInputChange(event) {
    const target = event.target;
    const value =
      target.type === 'checkbox'
        ? target.checked
        : target.type === 'select'
          ? +target.value
          : target.value;

    this.setState({
      sortType: value
    });
    this.props.sortSymbols(value);
  }

  render() {
    const { sortType } = this.state;
    return (
      <Form.Group
        controlId='sort-icon'
        className='mb-2'>
        <Form.Control
          size='sm'
          as='select'
          data-state-key='sortType'
          value={sortType}
          onChange={this.handleInputChange}>
          <option value='default'>Default</option>
          <option value='name'>Name (Alphabetically)</option>
          <option value='buy'>Buy difference</option>
          <option value='sell'>Sell difference</option>
          <option value='profit'>Profit</option>
        </Form.Control>
      </Form.Group>
    );
  }
}
