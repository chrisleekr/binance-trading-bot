from selenium import webdriver
from selenium.webdriver.firefox.options import Options
import json
from flask import Flask, Response
import datetime

app = Flask(__name__)

@app.route('/get-best-worst')
def get_best_worst():
    result = {
        'worst': {},
        'best': {}
    }

    options = Options()
    options.headless = True
    driver = webdriver.Firefox(options=options)

    driver.get('https://www.binance.com/en/markets')

    driver.find_element_by_id('market_filter_spot_FIAT').click()
    driver.find_element_by_id('market_3rd_filter_FIAT_USDT').click()
    driver.find_element_by_xpath('/html/body/div[1]/div[1]/main/div/div[2]/div/div[2]/div[2]/div[1]/div[2]/div/button/div').click()
    driver.find_element_by_xpath('/html/body/div[1]/div[1]/main/div/div[2]/div/div[2]/div[2]/div[1]/div[2]/div/div/div/label[1]/div[2]').click()

    # Find worst coins
    driver.find_element_by_css_selector('div[data-bn-type="text"][title="24h Change"]').click()
    worst = driver.find_elements_by_css_selector('div#market_trade_list_item')
    for elem in worst:
        coin = elem.find_element_by_css_selector('.css-7ea2d1 .css-1c1ahuy').get_attribute('innerHTML') + 'USDT'
        percentage = elem.find_element_by_css_selector('.css-irnzyj').get_attribute('innerHTML')
        result['worst'][coin] = percentage

    # Find best coins
    driver.find_element_by_css_selector('div[data-bn-type="text"][title="24h Change"]').click()
    worst = driver.find_elements_by_css_selector('div#market_trade_list_item')
    for elem in worst:
        coin = elem.find_element_by_css_selector('.css-7ea2d1 .css-1c1ahuy').get_attribute('innerHTML') + 'USDT'
        percentage = elem.find_element_by_css_selector('.css-1an68lg').get_attribute('innerHTML')
        result['best'][coin] = percentage

    driver.close()

    result['timestamp'] = datetime.datetime.utcnow().isoformat()

    return Response(json.dumps(result), mimetype='application/json')


if __name__ == "__main__":
    app.run(host='0.0.0.0', port='9090')
