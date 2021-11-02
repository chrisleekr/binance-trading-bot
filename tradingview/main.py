import logging
import sys
import colorlog

from flask import Flask, jsonify, request
from tradingview_ta import get_multiple_analysis

app = Flask(__name__)

logger = logging.getLogger('')
logger.setLevel(logging.DEBUG)
sh = logging.StreamHandler(sys.stdout)
sh.setFormatter(colorlog.ColoredFormatter(
    '%(log_color)s [%(asctime)s] %(levelname)s [%(filename)s.%(funcName)s:%(lineno)d] %(message)s', datefmt='%a, %d %b %Y %H:%M:%S'))
logger.addHandler(sh)


@app.route('/', methods=['GET'])
def index():
    logger.info("Request: "+str(request.args))
    symbols = request.args.getlist('symbols')
    screener = request.args.get('screener')
    interval = request.args.get('interval')

    analyse = get_multiple_analysis(
        screener, interval, symbols
    )

    result = {}
    for symbol in symbols:
        symbolAnalyse = analyse[symbol]
        if not (symbolAnalyse is None):
            result[symbol] = {
                'summary': symbolAnalyse.summary, 'time': symbolAnalyse.time.isoformat(), 'oscillators': symbolAnalyse.oscillators, 'moving_averages': symbolAnalyse.moving_averages, 'indicators': symbolAnalyse.indicators}
        else:
            result[symbol] = {}
        # logger.info('Processed '+symbol)

    response = {
        'request': {
            'symbols': symbols,
            'screener': screener,
            'interval': interval
        },
        'result': result
    }
    logger.info("Response: "+str(response))
    return jsonify(response)


if __name__ == "__main__":
    from waitress import serve
    serve(app, host="0.0.0.0", port=8080)
