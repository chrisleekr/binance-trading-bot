#!/bin/sh

set -e

BACKUP_PATH=$1

if [ -z "$BACKUP_PATH" ];
then
    echo "Usage: $0 /tmp/backup-20220828.archive"
    exit 1
fi

# Backup using mongodump excluding `trailing-trade-logs`
mongodump --host=binance-mongo --port=27017 --gzip --archive="$BACKUP_PATH" --db=binance-bot --excludeCollection=trailing-trade-logs

