/* eslint-disable react/jsx-no-undef */
/* eslint-disable no-undef */

const sortingAlpha = (symbols, direction) =>
  _.orderBy(symbols, s => s.symbol, direction);

const sortingSellProfit = (symbols, direction) =>
  _.orderBy(
    symbols,
    s =>
      s.sell.currentProfitPercentage !== null
        ? s.sell.currentProfitPercentage
        : direction === 'asc'
        ? 999
        : -999,
    direction
  );

const sortingBuyDifference = (symbols, direction) =>
  _.orderBy(
    symbols,
    s =>
      s.buy.difference !== null
        ? s.buy.difference
        : direction === 'asc'
        ? 999
        : -999,
    direction
  );

const sortingDefault = (symbols, direction) =>
  _.orderBy(
    symbols,
    s => {
      if (s.buy.openOrders.length > 0) {
        const openOrder = s.buy.openOrders[0];
        if (openOrder.differenceToCancel) {
          return (openOrder.differenceToCancel + 3000) * -10;
        }
      }
      if (s.sell.openOrders.length > 0) {
        const openOrder = s.sell.openOrders[0];
        if (openOrder.differenceToCancel) {
          return (openOrder.differenceToCancel + 2000) * -10;
        }
      }
      if (s.sell.difference) {
        return (s.sell.difference + 1000) * -10;
      }
      return s.buy.difference;
    },
    direction
  );

// eslint-disable-next-line no-unused-vars
const sortingSymbols = (orgSymbols, { selectedSortOption, searchKeyword }) => {
  const symbols = orgSymbols.filter(s =>
    s.symbol.toLowerCase().includes(searchKeyword.toLowerCase())
  );
  const sortingMaps = {
    default: {
      sortingFunc: sortingDefault,
      direction: 'asc'
    },
    'buy-difference-asc': {
      sortingFunc: sortingBuyDifference,
      direction: 'asc'
    },
    'buy-difference-desc': {
      sortingFunc: sortingBuyDifference,
      direction: 'desc'
    },
    'sell-profit-asc': {
      sortingFunc: sortingSellProfit,
      direction: 'asc'
    },
    'sell-profit-desc': {
      sortingFunc: sortingSellProfit,
      direction: 'desc'
    },
    'alpha-asc': {
      sortingFunc: sortingAlpha,
      direction: 'asc'
    },
    'alpha-desc': {
      sortingFunc: sortingAlpha,
      direction: 'desc'
    }
  };

  const sortingMap = sortingMaps[selectedSortOption];

  return sortingMap.sortingFunc(symbols, sortingMap.direction);
};
