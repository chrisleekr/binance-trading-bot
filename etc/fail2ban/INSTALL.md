# Fail2ban Configuration

If authentication is enabled, you can ban clients with fail2ban if they try to brute force authentication.
NB : you've to log at least one time, to create the `logs/auth.log` file, before enabling fail2ban config.

Copy local filter to `/etc/fail2ban/filter.d` directory :

```
sudo cp ./etc/fail2ban/filter.d/binance-trading-bot.conf /etc/fail2ban/filter.d/
```

Copy and **customize the path log** for the jail in `/etc/fail2ban/jail.d` directory :

```
sudo cp ./etc/fail2ban/jail.d/binance-trading-bot.conf /etc/fail2ban/jail.d/
```

Restart and check the fail2ban service :

```
sudo service fail2ban restart
sudo fail2ban-client status
sudo fail2ban-client status binance-trading-bot
```
