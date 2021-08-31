# Fail2ban Configuration

If authentication is enabled, you can ban clients with fail2ban if they try to brute force authentication.

NB : you've to log at least one time, to create the `fail2ban/logs/binance-trailing-bot-auth.log` file, before enabling fail2ban config.

To enable fail2ban, open `docker-compose.server.yml` file and uncomment `binance-fail2ban` container definition.

If you are using Raspberry Pi, open `docker-compose.rpi.yml`.

```yml
binance-fail2ban:
    image: crazymax/fail2ban:latest
    container_name: binance-fail2ban
    network_mode: host
    cap_add:
      - NET_ADMIN
      - NET_RAW
    volumes:
      # mount separately to avoid db folder is created
      - ./fail2ban/filter.d:/data/filter.d
      - ./fail2ban/jail.d:/data/jail.d
      - ./fail2ban/logs:/data/logs
    restart: always
```
