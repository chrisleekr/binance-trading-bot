import type { Config } from 'drizzle-kit';

const adminConn =
  process.env['ADMIN_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/binance_trading_bot';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: adminConn,
  },
  verbose: true,
  strict: true,
} satisfies Config;
