const config = require('config');
const { upperCase } = require('lodash');
const { Telegraf } = require('telegraf')
const { Keyboard, Key } = require('telegram-keyboard');
const cache = require('./cache');
const _ = require('lodash');

// replace the value below with the Telegram token you receive from @BotFather
const token = config.get('telegram.token');
// read the doc from https://github.com/yagop/node-telegram-bot-api to know how to catch the chatId
const chatId = config.get('telegram.chatid');
const bot = new Telegraf(token)

let botTrailingTradeIndicatorData = {};
const updateTelegramBotTrailingTradeIndicatorData = async (data) => {
  botTrailingTradeIndicatorData = data;
}
let botLatestData = {};
const updateTelegramBotLatestData = async (data) => {
  botLatestData = data;
}
let botTrailingTradeData = [];
const updateTelegramBotTrailingTradeData = async (data) => {
  const foundData = find(botTrailingTradeData, data.symbol);
  if (foundData !== undefined) {
    //This is to update the symbols stored and not create one thousand of items
    let i = 0;
    botTrailingTradeData.forEach(element => {
      if (element.symbol === foundData.symbol) {
        botTrailingTradeData[i] = data;
      }
      i++;
    });
  } else {
    botTrailingTradeData.push(data)
  }
}

const find = (array, symbol) => {
  var result;
  array.some(o => result = o.symbol === symbol ? o : find(o.children || [], symbol));
  return result;
};


const notifyTelegram = (message) => {
  bot.telegram.sendMessage(chatId, message, { parse_mode: "MARKDOWN" })
}

const mainMenuKeyboard = Keyboard.make([
  [Key.callback('Symbol Details', 'symbol-details')],
  [Key.callback('Actual Profit', 'actual-profit')],
  [Key.callback('Last Trade Done', 'last-trade')],
  [Key.callback('Manual Trade', 'manual-trade')],
  [Key.callback('Active Orders', 'active-orders')],
  [Key.callback('Past Trades', 'past-trades')],
  [Key.callback('Reset Cache', 'reset-cache')],
]).inline()

const symbolActionKeyboard = Keyboard.make([
  [Key.callback('Symbol Manual Trade', 'symbol-orders')],
  [Key.callback('Symbol Actual Profit', 'symbol-actual-profit')],
  [Key.callback('Change Symbol Configuration', 'active-orders')],
  [Key.callback('Clear Symbol Cache', 'clear-symbol-cache')],
  [Key.callback('Back to symbols select', 'back-symbols-list-action')],
  [Key.callback('Back to main menu', 'back-menu-action')]
]).inline()

const manualTradeKeyboardOrderType = Keyboard.make([
  [Key.callback('Limit', 'select-type-limit')],
  [Key.callback('Market', 'select-type-market')],
  [Key.callback('Back to main menu', 'back-menu-action')]
]).inline()

const manualTradeKeyboardOrderSide = Keyboard.make([
  [Key.callback('Buy', 'select-side-buy')],
  [Key.callback('Sell', 'select-side-sell')],
  [Key.callback('Back to main menu', 'back-menu-action')]
]).inline()

const manualTradeKeyboardOrderConfirm = Keyboard.make([
  [Key.callback('Confirm', 'order-confirm')],
  [Key.callback('Cancel', 'action-cancel')],
  [Key.callback('Back to main menu', 'back-menu-action')]
]).inline()


//Variables
let symbolSelected = '';
let orderTypeSelected = '';
let orderSideSelected = '';
let orderAmountSelected = '';
let orderLimitSelected = '';
let symbolDataSelected = {}
let symbolsKeyboard = {};
let symbolsOrderKeyboard = {};
//

bot.hears(['Jarvis', 'jarvis', 'jrvs', 'jrvis', 'JARVIS', 'bot', 'BOT', 'Bot', 'bt',
  'BT', 'hey', 'Hey', 'HEY', 'hi', 'HI', 'Hi'], async (ctx) => {

    symbolSelected = '';
    orderTypeSelected = '';
    orderSideSelected = '';
    orderAmountSelected = '';
    orderLimitSelected = '';
    symbolDataSelected = {};

    const cachedDate =
      JSON.parse(await cache.get(`last-seen-telegram`)) || {};

    const dateDifference = (((new Date() - new Date(cachedDate)) / 1000) / 60).toFixed(1);

    ctx.reply(`Hi. It has been ${dateDifference} minutes since your last visit.`, mainMenuKeyboard)

    await cache.set('last-seen-telegram', JSON.stringify(new Date()));
  })

bot.on('text', async (ctx) => {
  try {
    if (ctx.message.text.includes('Price:')) {
      const price = ctx.message.text.substring(7);
      orderLimitSelected = price;
      if (orderSideSelected === 'buy') {
        ctx.reply('Got it. Price: ' + orderLimitSelected + '\n' +
          'Now, how much the amount to buy ?' + await generateOrderPercentKeyboard())
      } else {
        ctx.reply('Got it. Price: ' + orderLimitSelected + '\n' +
          'Now, how much the amount to sell ?' + await generateOrderPercentKeyboard(true))
      }
    }

    if (ctx.message.text.includes('Quantity:')) {
      const quantity = ctx.message.text.substring(10);
      orderAmountSelected = quantity;

      symbolDataSelected = find(botTrailingTradeData, symbolSelected);
      const { symbolInfo: { filterLotSize: { stepSize }, quotePrecision } } = symbolDataSelected;


      const precision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;

      ctx.reply(`Got it. Quantity: ${orderAmountSelected}\n` +
        `Now lets verify your order:\n` +
        `Symbol: ${symbolSelected}\n` +
        `Order side: ${orderSideSelected}\n` +
        `Order amount: ${parseFloat(orderAmountSelected).toFixed(precision)} $\n` +
        `Order limit price: ${parseFloat(orderLimitSelected).toFixed(quotePrecision)}\n` +
        `Confirm this order?`, manualTradeKeyboardOrderConfirm);
    }

  } catch (error) {
    ctx.reply('error: ' + error)
  }
})

bot.on('callback_query', async (ctx) => {
  try {
    const action = ctx.callbackQuery.data;
    if (action.includes('select-symbol') || action.includes('symbol-manual')) {
      symbolSelected = action.substring(14);
    }
    if (action.includes('select-type')) {
      orderTypeSelected = action.substring(12);
    }
    if (action.includes('select-amount')) {
      orderAmountSelected = action.substring(14);
    }
    if (action.includes('select-side')) {
      orderSideSelected = action.substring(12);
    }
    if (action.includes('select-limit')) {
      orderLimitSelected = action.substring(13);
    }
    switch (action) {
      //Symbols Details
      case 'symbol-details':
        const { symbols } = botTrailingTradeIndicatorData.globalConfiguration;
        const symbolListKeyboard = [];

        symbols.forEach(symbol => {
          symbolListKeyboard.push([Key.callback(symbol, `select-symbol-${symbol}`)]);
        });

        symbolListKeyboard.push(Key.callback('Back', `back-menu-action`));

        symbolsKeyboard = Keyboard.make(symbolListKeyboard).inline();

        ctx.reply('Which one, please?', symbolsKeyboard)
        break;

      case `select-symbol-${symbolSelected}`:
        ctx.reply(`What you want to do with ${symbolSelected} ?`, symbolActionKeyboard);
        break;

      case 'back-symbols-list-action':
        ctx.reply(`Again, which one?`, symbolsKeyboard)
        break;
      //END Symbol Details

      //Manual Trade
      case 'manual-trade':
        const { symbols: symbolList } = botTrailingTradeIndicatorData.globalConfiguration;
        const symbolListKeyboardManual = [];

        symbolList.forEach(symbol => {
          symbolListKeyboardManual.push(Key.callback(symbol, `symbol-manual-${symbol}`))
        });

        symbolListKeyboardManual.push(Key.callback('Back', `back-menu-action`));

        symbolsOrderKeyboard = Keyboard.make(symbolListKeyboardManual).inline();

        ctx.reply('Which one to trade, please?', symbolsOrderKeyboard)
        break;

      case `symbol-manual-${symbolSelected}`:
        ctx.reply(`What type of order you'd like to open?`, manualTradeKeyboardOrderType);
        break;

      case `select-type-${orderTypeSelected}`:
        ctx.reply(`Understood. What is the side of the order?`, manualTradeKeyboardOrderSide);

        break;

      case `select-side-${orderSideSelected}`:
        try {
          if (orderSideSelected === 'buy') {
            if (orderTypeSelected === 'limit') {
              ctx.reply(`You choose a limit order. What is it's price? You can choose one here, or type 'Price: X', where X is your amount.`, await generateLimitKeyboard());
            } else {
              ctx.reply(`Got it. Now, select the quantity.`, await generateOrderPercentKeyboard());
            }
          } else {
            if (orderTypeSelected === 'limit') {
              ctx.reply(`You choose a limit order. What is it's price? You can choose one here, or type 'Price: X', where X is your amount.`, await generateLimitKeyboard());
            } else {
              ctx.reply(`Got it. Now, select the quantity. You can choose one here, or type 'Quantity: X', where X is your amount.`, await generateOrderPercentKeyboard(true));
            }
          }
        } catch (error) {
          ctx.reply(`error + ` + error);
        }
        break;

      case `select-amount-${orderAmountSelected}`:
        symbolDataSelected = find(botTrailingTradeData, symbolSelected);
        const { symbolInfo: { filterLotSize: { stepSize }, quotePrecision } } = symbolDataSelected;


        const precision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
        ctx.reply(`Understood. Quantity selected: ${orderAmountSelected}\n` +
          `Now let's verify the order.\n` +
          `Symbol: ${symbolSelected}\n` +
          `Order side: ${orderSideSelected}\n` +
          `Order amount: ${parseFloat(orderAmountSelected).toFixed(precision)} $\n` +
          `Order limit price: ${parseFloat(orderLimitSelected).toFixed(quotePrecision)}\n` +
          `Confirm this order?`, manualTradeKeyboardOrderConfirm);
        break;

      case `select-limit-${orderLimitSelected}`:
        ctx.reply(`Selected ${orderLimitSelected} as Limit Price. Now, select the quantity. You can select one option from here, or type 'Quantity: X' where X is your defined quantity.`, await generateOrderPercentKeyboard());
        break;

      case `order-confirm`:
        try {
          //Update data
          symbolDataSelected = find(botTrailingTradeData, symbolSelected);
          //

          await formatOrder(ctx, symbolDataSelected);
        } catch (error) {
          ctx.reply('Could not open the order. Error: ' + error);
        }
        break;
      //END Manual Trade

      //Back Menu - Cancel
      case 'back-menu-action':
        ctx.reply('What do you want to do?', mainMenuKeyboard)
        break;

      case 'action-cancel':
        ctx.reply('I had canceled the action. Need anything more?', Keyboard.make([
          [Key.callback('Main menu', 'back-menu-action')]
        ]).inline())
        break;
      //END Back Menu


      //Open Orders
      case 'active-orders':
        try {
          let openOrders = [];
          botTrailingTradeData.forEach(dataSymbol => {
            if (dataSymbol.openOrders.length > 0) {
              openOrders.push(dataSymbol.openOrders[0]);
            }
          });
          let i = 0;
          let orders = '';
          openOrders.forEach(openOrder => {
            const { symbol, price, stopPrice, currentPrice } = openOrder;
            const order = `Order Nº${i}\n` +
              `Symbol: ${symbol}\n` +
              `Price to execute: *${price}* $\n` +
              `Stop Price: ${stopPrice}\n` +
              `Current Price: ${currentPrice}`;
            orders += '\n\n' + order;
            i++;
          });
          if (openOrders.length === 0) {
            ctx.reply(`You *don't* have *open orders*.`, { parse_mode: "MARKDOWN" });
          } else {
            ctx.reply(orders, { parse_mode: "MARKDOWN" });
          }
        } catch (error) {
          ctx.reply("*Error* parsing data. Maybe you *don't* have *open orders*. " + error, { parse_mode: "MARKDOWN" });
        }
        break;
      //END Open Orders

      //Past Trades
      case 'past-trades':
        try {
          const cachedTrades = JSON.parse(await cache.get(`past-trades`)) || [];
          let pastTrades = '';
          cachedTrades.forEach(data => {
            const { symbol, profit, percent, date } = data;
            const trade = `Symbol: ${symbol}\n` +
              `Profit: *${profit.toFixed(3)}* $ - (*${percent.toFixed(2)}*%)\n` +
              `Date: ${date}`
            pastTrades += '\n\n' + trade;

          });
          ctx.reply(pastTrades, { parse_mode: "MARKDOWN" });
        } catch (error) {
          ctx.reply("*Error* parsing data. Maybe you *don't* have past trades.", { parse_mode: "MARKDOWN" });
        }
        break;
      //END Past Trades

      //Symbol Actual Profit
      case 'symbol-actual-profit':
        try {

          symbolDataSelected = find(botTrailingTradeData, symbolSelected);
          const { lastBuyPrice, lastQtyBought, currentPrice, currentProfitPercentage, currentProfit } = symbolDataSelected.sell;
          const lastAmountPurchased = (lastBuyPrice * lastQtyBought);
          const amountNow = (lastQtyBought * currentPrice);

          const actualProfit =
            `Last amount bought: ${lastAmountPurchased.toFixed(2)}\n` +
            `Amount value now: *${amountNow.toFixed(2)}*\n` +
            `Profit: *${currentProfit.toFixed(3)}* $ - (${currentProfitPercentage.toFixed(2)}%)`;

          ctx.reply(actualProfit, { parse_mode: "MARKDOWN" });
        } catch (error) {
          ctx.reply("*Error* parsing data. Maybe you *don't* have a open trade.", { parse_mode: "MARKDOWN" });
        }
        break;
      //END Symbol Actual Profit

      // Actual Profits
      case 'actual-profit':
        try {
          let finalProfits = '';
          symbolDataSelected.forEach(data => {
            const { lastBuyPrice, lastQtyBought, currentPrice, currentProfitPercentage, currentProfit } = data.sell;
            const lastAmountPurchased = (lastBuyPrice * lastQtyBought);
            const amountNow = (lastQtyBought * currentPrice);

            const actualProfit =
              `Last amount bought: ${lastAmountPurchased.toFixed(2)}\n` +
              `Amount value now: *${amountNow.toFixed(2)}*\n` +
              `Profit: *${currentProfit.toFixed(3)}* $ - (${currentProfitPercentage.toFixed(2)}%)`;
            finalProfits += '\n\n' + actualProfit;
          });
          ctx.reply(finalProfits, { parse_mode: "MARKDOWN" });
        } catch (error) {
          ctx.reply("*Error* parsing data. Maybe you *don't* have any open trade.\n" + error, { parse_mode: "MARKDOWN" });
        }
        break;
      //END Actual Profits

      //Last Trade Done
      case 'last-trade':
        try {
          const cachedTrades = JSON.parse(await cache.get(`past-trades`)) || [];
          const lastTrade = cachedTrades[(cachedTrades.length - 1)];
          const { symbol, profit, percent, date } = lastTrade;
          const trade = `Symbol: ${symbol}\n` +
            `Profit: *${profit.toFixed(3)}* $ - (*${percent.toFixed(2)}*%)\n` +
            `Date: ${date}`;

          ctx.reply(trade, { parse_mode: "MARKDOWN" });
        } catch (error) {
          ctx.reply("*Error* parsing data. Maybe you *don't* have any last order done.", { parse_mode: "MARKDOWN" });
        }
        break;
      //END Last Trade Done

      //Reset bot cache
      case 'reset-cache':
        const { deleteAllCache } = require('../cronjob/trailingTradeHelper/configuration');
        const { symbols: symbolsToDeleteFromCache } = botTrailingTradeIndicatorData.globalConfiguration;
        await deleteAllCache(symbolsToDeleteFromCache);
        ctx.reply('Done. Anything more?', mainMenuKeyboard);
        break;
      //END Reset bot cache

      default:
        break;
    }
  } catch (error) {
    ctx.reply('error' + error);
  }

  ctx.answerCbQuery(ctx.callbackQueryId);
})

const generateLimitKeyboard = async () => {
  //Update selected data
  symbolDataSelected = find(botTrailingTradeData, symbolSelected);
  //

  const { currentPrice } = symbolDataSelected.sell;
  //Setup LIMIT keyboard
  const minusThree = (currentPrice * 0.97);
  const minusTwo = (currentPrice * 0.98);
  const minusOne = (currentPrice * 0.99);
  const plusThree = (currentPrice * 1.03);
  const plusTwo = (currentPrice * 1.02);
  const plusOne = (currentPrice * 1.01);
  return Keyboard.make([
    [Key.callback(`-3% (${minusThree})`, `select-limit-${minusThree}`)],
    [Key.callback(`-2% (${minusTwo})`, `select-limit-${minusTwo}`)],
    [Key.callback(`-1% (${minusOne})`, `select-limit-${minusOne}`)],
    [Key.callback(`+1% (${plusOne})`, `select-limit-${plusOne}`)],
    [Key.callback(`+2% (${plusTwo})`, `select-limit-${plusTwo}`)],
    [Key.callback(`+3% (${plusThree})`, `select-limit-${plusThree}`)],
    [Key.callback('Back to main menu', 'back-menu-action')]
  ]).inline()
  //END Limit keyboard
}

const generateOrderPercentKeyboard = async (isSell = false) => {


  //Update selected data
  symbolDataSelected = find(botTrailingTradeData, symbolSelected);
  //

  const { symbolInfo: { quoteAsset } } = symbolDataSelected;
  const { balances } = symbolDataSelected.accountInfo;
  const { baseAssetBalance } = symbolDataSelected;

  let freeBalance;
  if (isSell) {
    freeBalance = baseAssetBalance.free;
  } else {
    balances.forEach(balance => {
      if (balance.asset === quoteAsset) {
        freeBalance = parseFloat(balance.free);
      }
    });
  }

  //Setup ORDER PERCENT keyboard

  const first = (freeBalance * 0.05);
  const second = (freeBalance * 0.25);
  const third = (freeBalance * 0.5);
  const forth = (freeBalance * 0.75);
  const fifth = (freeBalance * 1);
  return Keyboard.make([
    [Key.callback(`5% (${first})`, `select-amount-${first}`)],
    [Key.callback(`25% (${second})`, `select-amount-${second}`)],
    [Key.callback(`50% (${third})`, `select-amount-${third}`)],
    [Key.callback(`75% (${forth})`, `select-amount-${forth}`)],
    [Key.callback(`100% (${fifth})`, `select-amount-${fifth}`)],
    [Key.callback('Back to main menu', 'back-menu-action')]
  ]).inline()
  //End Order percent keyboard
}

const formatOrder = async (ctx, data) => {
  const binance = require('./binance');

  symbolDataSelected = find(botTrailingTradeData, symbolSelected);
  const { sell: { currentPrice }, symbolInfo: { filterLotSize: { stepSize }, filterPrice: { tickSize } } } = data;


  const precision = parseFloat(stepSize) === 1 ? 0 : stepSize.indexOf(1) - 1;
  const pricePrecision =
    parseFloat(tickSize) === 1 ? 0 : tickSize.indexOf(1) - 1;

  let orderAmount = 0;
  if (orderSideSelected === 'buy') {
    orderAmount = (parseFloat(orderAmountSelected) / currentPrice).toFixed(precision);
  } else {
    orderAmount = parseFloat(orderAmountSelected).toFixed(precision);
  }


  let orderResult;
  let order;
  if (orderTypeSelected === 'limit') {
    order = {
      symbol: symbolSelected,
      side: upperCase(orderSideSelected),
      type: upperCase(orderTypeSelected),
      quantity: orderAmount,
      price: parseFloat(_.floor(orderLimitSelected, pricePrecision))
    };
  } else {
    order = {
      symbol: symbolSelected,
      side: upperCase(orderSideSelected),
      type: upperCase(orderTypeSelected),
      quantity: orderAmount
    };
  }
  try {
    orderResult = await binance.client.order(order);
    ctx.reply('I had open the order for you. Good profits.');
    if (orderSideSelected === 'buy') {
      await cache.set(`${symbolSelected}-last-buy-order`, JSON.stringify(orderResult));
    } else {
      await cache.set(`${symbolSelected}-last-sell-order`, JSON.stringify(orderResult));
    }
  } catch (error) {
    ctx.reply('Binance refused with this error: ' + error);
  }
}

bot.launch()
module.exports = {
  notifyTelegram,
  updateTelegramBotTrailingTradeIndicatorData,
  updateTelegramBotLatestData,
  updateTelegramBotTrailingTradeData

}
