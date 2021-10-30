from http.server import BaseHTTPRequestHandler, HTTPServer
from tradingview_ta import TA_Handler, get_multiple_analysis
from urllib.parse import urlparse, parse_qs
import json

hostName = "0.0.0.0"
serverPort = 8080


class MyServer(BaseHTTPRequestHandler):
    def _set_headers(self, statusCode):
        self.send_response(statusCode)
        self.send_header('Content-type', 'application/json')
        self.end_headers()

    def _handle_symbol(self, qParsed):
        print('Process _handle_symbol')

        symbol = qParsed['symbol'][0]
        screener = qParsed['screener'][0]
        exchange = qParsed['exchange'][0]
        interval = qParsed['interval'][0]
        tv = TA_Handler(
            symbol=symbol,
            screener=screener,
            exchange=exchange,
            interval=interval
        )
        analyse = tv.get_analysis()

        print({symbol, screener, exchange, interval}, vars(analyse))
        self._set_headers(200)
        self.wfile.write(bytes(json.dumps({'request': {'symbol': symbol, 'screener': screener, 'exchange': exchange, 'interval': interval}, 'result': {
                         'summary': analyse.summary, 'time': analyse.time.isoformat(), 'oscillators': analyse.oscillators, 'moving_averages': analyse.moving_averages, 'indicators': analyse.indicators}}), "utf-8"))

    def _handle_symbols(self, qParsed):
        print('Process _handle_symbols')

        symbols = qParsed['symbols']
        screener = qParsed['screener'][0]
        interval = qParsed['interval'][0]

        analyse = get_multiple_analysis(
            screener, interval, symbols
        )

        result = {}
        for symbol in symbols:
            symbolAnalyse = analyse[symbol]
            result[symbol] = {
                'summary': symbolAnalyse.summary, 'time': symbolAnalyse.time.isoformat(), 'oscillators': symbolAnalyse.oscillators, 'moving_averages': symbolAnalyse.moving_averages, 'indicators': symbolAnalyse.indicators}

        print({tuple(symbols), screener, interval}, result)

        self._set_headers(200)
        self.wfile.write(bytes(json.dumps({'request': {
                         'symbols': symbols, 'screener': screener, 'interval': interval}, 'result': result}), "utf-8"))

    def do_HEAD(self):
        self._set_headers()

    def do_GET(self):
        o = urlparse(self.path)
        qParsed = parse_qs(o.query)

        symbolExists = 'symbol' in qParsed
        symbolsExists = 'symbols' in qParsed

        if symbolExists == True:
            self._handle_symbol(qParsed)
        elif symbolsExists == True:
            self._handle_symbols(qParsed)
        else:
            self._set_headers(500)
            self.wfile.write(bytes(json.dumps(
                {'request': qParsed, 'message': 'symbol or symbols must be provided.'})))


if __name__ == "__main__":
    webServer = HTTPServer((hostName, serverPort), MyServer)
    print("Server started http://%s:%s" % (hostName, serverPort))

    try:
        webServer.serve_forever()
    except KeyboardInterrupt:
        pass

    webServer.server_close()
    print("Server stopped.")
