const config = require('config');
const telegram = require('./telegram');
const slack = require('./slack');
const language = config.get('language.definedLanguage');

/**
 * Send slack message
 *
 * @param {*} text
 */
const sendMessage = async (symbol = null, lastOrder = null, action) => {
	var message = 'message not set';
	var quantity = 'quantity not set';
	var price = 'price not set';
	if (lastOrder != null) {
		quantity = lastOrder.quantity;
		price = lastOrder.price;
	}

	switch (language) {

		case 'vi':

			switch (action) {

				case 'NO_CANDLE_RECEIVED':
					message = `Tôi không thể đọc được nến từ Binance` +
						symbol + '\n' +
						`Hãy khởi động lại kết nối Websocket.`;
					break;

				case 'BALANCE_INFO':
					message = symbol;
					break;

				case 'PLACE_BUY':
					message = '*Đang đặt lệnh* mua. 💵\n' +
						'Coin: ' + symbol + '\n' +
						'Số lượng: ' + quantity + '\n' +
						'Giá mua: ' + price;
					break;

				case 'PLACE_BUY_DONE':
					message = 'Đã mua *thành công*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'PLACE_SELL':
					message = '*Đang đặt lệnh* bán. 💵\n' +
						'Coin: ' + symbol + '\n' +
						'Số lượng: ' + quantity + '\n' +
						'Giá bán: ' + price;
					break;

				case 'PLACE_SELL_DONE':
					message = 'Đã bán *thành công*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'CHECK_BUY':
					message = '*Kiểm tra* lệnh mua ' + symbol + ' ... 🔍';
					break;

				case 'CHECK_SELL':
					message = '*Kiểm tra* ' + symbol + ' bán ... 🔍 ';
					break;

				case 'BUY_CONFIRMED':
					message = 'Đã đặt mua *thành công*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'BUY_NOT_FOUND':
					message = 'Lệnh mua ' + symbol + ' *không tìm thấy*. ' + '❌' + 'đang thử lại...';
					break;

				case 'SELL_CONFIRMED':
					message = 'Đã đặt bán *thành công*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'SELL_NOT_FOUND':
					message = 'Lệnh bán ' + symbol + ' *không tìm thấy*. ' + '❌' + ' đang thử lại...';
					break;

				case 'CANCEL_BUY':
					message = 'Lệnh mua ' + symbol + ' *đã được huỷ*.';
					break;

				case 'CANCEL_BUY_FAILED':
					message = 'Lệnh mua ' + symbol + ' *không huỷ được*. ' + '🚨' + '\n đang thử lại...';
					break;

				case 'CANCEL_SELL':
					message = 'Lệnh bán ' + symbol + ' *đã được huỷ*.';
					break;

				case 'CANCEL_SELL_FAILED':

					message = 'Lệnh bán ' + symbol + ' *không huỷ được*. ' + '🚨' + '\n đang thử lại...';
					break;

				case 'SELL_STOP_LOSS':
					message = 'Bán *tất cả* số coin  ' + symbol + ' vì bán cắt lỗ.';
					break;

				case 'REMOVE_LASTBUY':
					message = 'Đang xoá giá mua gần nhất *' + symbol + '*.';
					break;

				case 'LINK':
					message = 'Bot *link*: ' + symbol;
					break;

				default:
					message = 'Thông cảm. Tôi chưa xác định được vấn đề mua bán. Chắc đang có vấn đề.\n' +
						action + '\n' +
						symbol;
					break;
			}
			break;

		case 'en':

			switch (action) {

				case 'NO_CANDLE_RECEIVED':
					message = `I couldn't receive new candle from Binance Websocket since` +
						symbol + '\n' +
						`Please, reset my Websocket connection.`;
					break;

				case 'BALANCE_INFO':
					message = symbol;
					break;

				case 'PLACE_BUY':
					message = '*Placing* buy order. 💵\n' +
						'Coin: ' + symbol + '\n' +
						'Quantity: ' + quantity + '\n' +
						'At price: ' + price;
					break;

				case 'PLACE_BUY_DONE':
					message = 'Buy order placed *successfully*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'PLACE_SELL':
					message = '*Placing* sell order. 💵\n' +
						'Coin: ' + symbol + '\n' +
						'Quantity: ' + quantity + '\n' +
						'At price: ' + price;
					break;

				case 'PLACE_SELL_DONE':
					message = 'Sell order placed *successfully*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'CHECK_BUY':
					message = '*Checking* purchase of ' + symbol + ' ... 🔍';
					break;

				case 'CHECK_SELL':
					message = '*Checking* ' + symbol + ' sold ... 🔍 ';
					break;

				case 'BUY_CONFIRMED':
					message = 'Buy order confirmed *successfully*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'BUY_NOT_FOUND':
					message = 'Buy order of ' + symbol + ' *was not found*. ' + '❌' + ' retrying...';
					break;

				case 'SELL_CONFIRMED':
					message = 'Sell confirmed *successfully*. ✔\n' +
						'Coin: ' + symbol;
					break;

				case 'SELL_NOT_FOUND':
					message = 'Sell order of ' + symbol + ' *was not found*. ' + '❌' + ' retrying...';
					break;

				case 'CANCEL_BUY':
					message = 'Buy order of ' + symbol + ' *was canceled*.';
					break;

				case 'CANCEL_BUY_FAILED':
					message = 'Buy order of ' + symbol + ' *coudnt be canceled*. ' + '🚨' + '\n retrying...';
					break;

				case 'CANCEL_SELL':
					message = 'Sell order of ' + symbol + ' *was canceled*.';
					break;

				case 'CANCEL_SELL_FAILED':

					message = 'Sell order of ' + symbol + ' *coudnt be canceled*. ' + '🚨' + '\n retrying...';
					break;

				case 'SELL_STOP_LOSS':
					message = 'Sold *all* of  ' + symbol + ' because of stop-loss.';
					break;

				case 'REMOVE_LASTBUY':
					message = 'Removing last buy price from *' + symbol + '*.';
					break;

				case 'LINK':
					message = 'Bot *link*: ' + symbol;
					break;

				default:
					message = 'Sorry. I was unable to determine the action. Something is wrong.\n' +
						action + '\n' +
						symbol;
					break;
			}
			break;

		case 'pt':

			switch (action) {

				case 'NO_CANDLE_RECEIVED':
					message = `Não recebi nenhuma vela de dados da Binance Websocket desde` +
						symbol + '\n' +
						`Please, reset my Websocket connection.`;
					break;

				case 'BALANCE_INFO':
					message = symbol;
					break;

				case 'PLACE_BUY':
					message = '*Processando* ordem de compra. 💵\n' +
						'Moeda: ' + symbol + '\n' +
						'Quantidade: ' + quantity + '\n' +
						'Preço: ' + price;
					break;

				case 'PLACE_BUY_DONE':
					message = 'Ordem de compra processada *com sucesso*. ✔\n' +
						'Moeda: ' + symbol;
					break;

				case 'PLACE_SELL':
					message = '*Processando* ordem de venda. 💵\n' +
						'Moeda: ' + symbol + '\n' +
						'Quantidade: ' + quantity + '\n' +
						'Preço: ' + price;
					break;

				case 'PLACE_SELL_DONE':
					message = 'Ordem de venda processada *com sucesso*. ✔\n' +
						'Moeda: ' + symbol;
					break;

				case 'CHECK_BUY':
					message = '*Checando* compra de:  ' + symbol + ' ... 🔍';
					break;

				case 'CHECK_SELL':
					message = '*Checando* venda de: ' + symbol + ' ... 🔍';
					break;

				case 'BUY_CONFIRMED':
					message = 'Ordem de compra foi posta no livro de ordens *com sucesso*. ✔\n' +
						'Moeda: ' + symbol;
					break;

				case 'BUY_NOT_FOUND':
					message = 'Ordem de compra de ' + symbol + ' *não foi encontrada* no livro de ordens. ' + '❌' + ' tentando de novo...';
					break;

				case 'SELL_CONFIRMED':
					message = 'Ordem de venda foi posta no livro de ordens *com sucesso*. ✔\n' +
						'Moeda: ' + symbol;
					break;

				case 'SELL_NOT_FOUND':
					message = 'Ordem de venda de: ' + symbol + ' *não foi encontrada* no livro de ordens. ' + '❌' + ' tentando de novo...';
					break;

				case 'CANCEL_BUY':
					message = 'Ordem de compra de: ' + symbol + ' *foi cancelada*.';
					break;

				case 'CANCEL_BUY_FAILED':
					message = 'Ordem de compra de: ' + symbol + ' *não pôde ser cancelada*.' + '🚨' + '\n tentando de novo...';
					break;

				case 'CANCEL_SELL':
					message = 'Ordem de venda de: ' + symbol + ' *foi cancelada*.';
					break;

				case 'CANCEL_SELL_FAILED':

					message = 'Ordem de venda de: ' + symbol + ' *não pôde ser cancelada*.' + '🚨' + '\n tentando de novo...';
					break;

				case 'SELL_STOP_LOSS':
					message = 'Vendi *TUDO* de:  ' + symbol + ' por causa do para-perda.';
					break;

				case 'REMOVE_LASTBUY':
					message = 'Removendo último preço comprado de: *' + symbol + '*.';
					break;

				case 'LINK':
					message = 'Bot *link*: ' + symbol;
					break;

			}
			break;
	}

	if (config.get('slack.enabled') == true) {
		slack.notifySlack(message);
	}
	if (config.get('telegram.enabled') == true) {
		telegram.notifyTelegram(message);
	}
};

const errorMessage = text => {
	if (config.get('slack.enabled') == true) {
		slack.notifySlack(text);
	}
	if (config.get('telegram.enabled') == true) {
		telegram.notifyTelegram(text);
	}
};

module.exports = { sendMessage, errorMessage };
