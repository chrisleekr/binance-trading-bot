from http.server import BaseHTTPRequestHandler, HTTPServer
from tradingview_ta import TA_Handler, Interval, Exchange
import time
from urllib.parse import urlparse, parse_qs
import json
hostName = "0.0.0.0"
serverPort = 8080


class MyServer(BaseHTTPRequestHandler):
    def _set_headers(self):
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()

    def do_HEAD(self):
        self._set_headers()

    def do_GET(self):
        o = urlparse(self.path)
        qParsed = parse_qs(o.query)
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

        print({symbol, screener, exchange, interval}, analyse)
        self._set_headers()
        self.wfile.write(bytes(json.dumps({'request': {'symbol': symbol, 'screener': screener, 'exchange': exchange, 'interval': interval}, 'result': {
                         'summary': analyse.summary, 'time': analyse.time.isoformat(), 'oscillators': analyse.oscillators, 'moving_averages': analyse.moving_averages, 'indicators': analyse.indicators}}), "utf-8"))


if __name__ == "__main__":
    webServer = HTTPServer((hostName, serverPort), MyServer)
    print("Server started http://%s:%s" % (hostName, serverPort))

    try:
        webServer.serve_forever()
    except KeyboardInterrupt:
        pass

    webServer.server_close()
    print("Server stopped.")
