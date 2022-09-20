#!/bin/sh

set -e

BINANCE_MONGO_HOST=$1
BINANCE_MONGO_PORT=$2
BACKUP_PATH=$3

if [ -z "$BACKUP_PATH" ] || [ -z "$BINANCE_MONGO_HOST" ] || [ -z "$BINANCE_MONGO_PORT" ] ;
then
    echo "Usage: $0 binance-mongo 27017 /tmp/backup-20220828.archive"
    exit 1
fi

# Restore using mongorestore excluding `trailing-trade-logs`
mongorestore --host="$BINANCE_MONGO_HOST" --port="$BINANCE_MONGO_PORT" --gzip --archive="$BACKUP_PATH" --drop

# Flush redis
redis-cli -h "$BINANCE_REDIS_HOST" -p "$BINANCE_REDIS_PORT" -a "$BINANCE_REDIS_PASSWORD" FLUSHALL

# Kill the node process to restart
pkill -f node
