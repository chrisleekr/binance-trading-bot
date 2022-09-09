#!/bin/sh

set -e

BACKUP_PATH=$1

if [ -z "$BACKUP_PATH" ];
then
    echo "Usage: $0 /tmp/backup-20220828.archive"
    exit 1
fi

# Restore using mongorestore excluding `trailing-trade-logs`
mongorestore --host=binance-mongo --port=27017 --gzip --archive="$BACKUP_PATH" --drop

# Flush redis
redis-cli -h "$BINANCE_REDIS_HOST" -p "$BINANCE_REDIS_PORT" -a "$BINANCE_REDIS_PASSWORD" FLUSHALL

# Kill the node process to restart
pkill -f node
