#!/bin/sh

set -e

BINANCE_MONGO_HOST=$1
BINANCE_MONGO_PORT=$2
BINANCE_MONGO_DATABASE=$3
BACKUP_PATH=$4

if [ -z "$BACKUP_PATH" ] || [ -z "$BINANCE_MONGO_HOST" ] || [ -z "$BINANCE_MONGO_PORT" ] || [ -z "$BINANCE_MONGO_DATABASE" ];
then
    echo "Usage: $0 binance-mongo 27017 binance-bot /tmp/backup-20220828.archive"
    exit 1
fi

# Backup using mongodump excluding `trailing-trade-logs`
mongodump --host="$BINANCE_MONGO_HOST" --port="$BINANCE_MONGO_PORT" --gzip --archive="$BACKUP_PATH" --db="$BINANCE_MONGO_DATABASE" --excludeCollection=trailing-trade-logs

