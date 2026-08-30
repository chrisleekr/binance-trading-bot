alter table trade_archive
  add column if not exists fees_quote_complete boolean not null default false;

alter table orders
  add column if not exists base_commission_netted numeric(38, 18);

alter table equity_snapshots
  add column if not exists fees_quote_complete boolean not null default false;
