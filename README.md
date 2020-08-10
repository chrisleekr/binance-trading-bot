# Binance Auto Trading API

## How to use

1. Create `.env` file based on `.env.dist`.

2. Check `docker-compose.yml` for `BINANCE_MODE` environment parameter

3. Launch docker compose

```bash
$ docker-compose up -d
```

or

```bash
$ docker-compose -f docker-compose.server.yml up -d
```

## Environment Parameters

Use environment parameter to adjust parameters. Checkout `/config/custom-environment-variables.json`
