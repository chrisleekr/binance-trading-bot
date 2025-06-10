from colorama import Fore, Style
from tradingview_ta import TA_Handler, Interval, get_multiple_analysis
import tradingview_ta, requests, argparse

arg_parser = argparse.ArgumentParser()

arg_parser.add_argument("--proxy", help="Use HTTP proxy")
arg_parser.add_argument("--secureproxy", help="Use HTTPS proxy")

args = arg_parser.parse_args()
proxies = {}
if args.proxy:
    proxies["http"] = args.proxy
if args.secureproxy:
    proxies["https"] = args.secureproxy

print("------------------------------------------------")
print("Testing {}Tradingview-TA{} v{}{}".format(Fore.CYAN, Fore.MAGENTA, tradingview_ta.__version__, Style.RESET_ALL))
print("This test is {}semi-automatic{}. Please compare with tradingview's data manually.".format(Fore.LIGHTRED_EX, Style.RESET_ALL))
print("------------------------------------------------")

COUNT = 7
success = 0

print("{}#0{} {}Testing invalid symbol{}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
handler = TA_Handler(
    symbol="ThisSymbolIsInvalid",
    interval="1m",
    screener="america",
    exchange="NASDAQ",
    proxies = proxies
)
try:
    analysis = handler.get_analysis()
    if analysis:
        print("{}#0{} Invalid symbol test {}failed{}. No exception occured.".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))
except Exception as e:
    if str(e) == "Exchange or symbol not found.":
        print("{}#0{} Invalid symbol test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1
    else:
        print("{}#0{} Invalid symbol test {}failed{}. An exception occured, but the symbol is valid.".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))


print("{}#1{} {}Testing invalid exchange{}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
handler = TA_Handler(
    symbol="TSLA",
    interval="1m",
    screener="america",
    exchange="binance",
    proxies = proxies
)
try:
    analysis = handler.get_analysis()
    if analysis:
        print("{}#1{} Invalid exchange test {}failed{}. No exception occured.".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))
except Exception as e:
    if str(e) == "Exchange or symbol not found.":
        print("{}#1{} Invalid exchange test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1
    else:
        print("{}#1{} Invalid exchange test {}failed{}. An exception occured, but symbol is valid.".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))

print("{}#2{} {}Testing timeout{}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
handler = TA_Handler(
    symbol="AAPL",
    interval=Interval.INTERVAL_1_DAY,
    screener="america",
    exchange="NASDAQ",
    timeout=0.0001,
    proxies = proxies
)
try:
    analysis = handler.get_analysis()
    if analysis:
        print("{}#2{} Timeout test {}failed{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))
except Exception as e:
    if type(e) == requests.exceptions.ConnectTimeout:
        print("{}#2{} Timeout test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1


print("{}#3{} {}Testing invalid interval{}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
handler = TA_Handler(
    symbol="TSLA",
    interval="1 minute",
    screener="america",
    exchange="NASDAQ",
    proxies = proxies
)
try:
    analysis = handler.get_analysis()
    if analysis and input('{}#3{} Did you see a "defaulting to 1 day" {}warning{}? (Y/N) '.format(Fore.BLUE, Style.RESET_ALL, Fore.YELLOW, Style.RESET_ALL)).lower() == "y":
        print("{}#3{} Invalid interval test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1
    else:
        print("{}#3{} Invalid interval test {}failed{}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))

except Exception as e:
    print("{}#3{} Invalid interval test {}failed{}. An exception occured: {}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL, e))

print("{}#4{} {}Testing stock (NASDAQ:AAPL){}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
handler = TA_Handler(
    symbol="AAPL",
    interval=Interval.INTERVAL_1_DAY,
    screener="america",
    exchange="NASDAQ",
    proxies = proxies
)
try:
    analysis = handler.get_analysis()
    print("{}#4{} Please compare with {}https://www.tradingview.com/symbols/NASDAQ-AAPL/technicals/{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTMAGENTA_EX, Style.RESET_ALL))
    print("{}#4{} (Summary) Rec: {}, Sell: {}, Neutral: {}, Buy: {}".format(Fore.BLUE, Style.RESET_ALL, analysis.summary["RECOMMENDATION"], analysis.summary["SELL"], analysis.summary["NEUTRAL"], analysis.summary["BUY"]))
    if input("{}#4{} Are the results the same? (Y/N) ".format(Fore.BLUE, Style.RESET_ALL)).lower() == "y":
        print("{}#4{} Stock test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1
    else:
        print("{}#4{} Stock test {}failed{}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))
except Exception as e:
    print("{}#4{} Stock test {}failed{}. An exception occured: {}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL, e))

print("{}#5{} {}Testing multiple analysis (NASDAQ:TSLA and NYSE:DOCN){}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
try:
    analysis = get_multiple_analysis(screener="america", interval=Interval.INTERVAL_1_HOUR, symbols=["nasdaq:tsla", "nyse:docn"])
    for key, value in analysis.items():
        print("{}#5{} Please compare with {}https://www.tradingview.com/symbols/{}/technicals/{}. (Switch to 1 hour tab)".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTMAGENTA_EX, key, Style.RESET_ALL))
        print("{}#5{} (Summary) Rec: {}, Sell: {}, Neutral: {}, Buy: {}".format(Fore.BLUE, Style.RESET_ALL, value.summary["RECOMMENDATION"], value.summary["SELL"], value.summary["NEUTRAL"], value.summary["BUY"]))
    if input("{}#5{} Are the results the same? (Y/N) ".format(Fore.BLUE, Style.RESET_ALL)).lower() == "y":
        print("{}#5{} Multiple analysis test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1
    else:
        print("{}#5{} Multiple analysis test {}failed{}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))
except Exception as e:
    print("{}#5{} Multiple analysis test {}failed{}. An exception occured: {}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL, e))

print("{}#6{} {}Testing get indicators (BINANCE:BTCUSDT){}".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTBLUE_EX, Style.RESET_ALL))
handler = TA_Handler(
    symbol="BTCUSDT",
    interval=Interval.INTERVAL_1_DAY,
    screener="crypto",
    exchange="binance",
    proxies = proxies
)
try:
    print("{}#6{} Please compare with {}https://www.tradingview.com/symbols/BINANCE:BTCUSDT/technicals/{}. (Check for indicators)".format(Fore.BLUE, Style.RESET_ALL, Fore.LIGHTMAGENTA_EX, Style.RESET_ALL))
    print("{}#6{} {}".format(Fore.BLUE, Style.RESET_ALL, handler.get_indicators()))
    if input("{}#6{} Are the results the same? (Y/N) ".format(Fore.BLUE, Style.RESET_ALL)).lower() == "y":
        print("{}#6{} Get indicators test {}success{}.".format(Fore.BLUE, Style.RESET_ALL, Fore.GREEN, Style.RESET_ALL))
        success += 1
    else:
        print("{}#6{} Get indicators test {}failed{}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL))
except Exception as e:
    print("{}#6{} Get indicators test {}failed{}. An exception occured: {}".format(Fore.BLUE, Style.RESET_ALL, Fore.RED, Style.RESET_ALL, e))


print("------------------------------------------------")
print("Test finished. Result: {}{}/{}{}.".format(Fore.LIGHTWHITE_EX, success, COUNT, Style.RESET_ALL))
