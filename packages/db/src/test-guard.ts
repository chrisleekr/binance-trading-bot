/**
 * Guard the destructive test harnesses against the live database.
 *
 * The api integration suite (`apps/api/__tests__/_helpers.ts`) TRUNCATEs, and
 * the db isolation suites delete rows, on whatever `DATABASE_TEST_URL` points
 * at. A value aimed at a live database (the app's `binance_trading_bot`) wipes
 * real data — this has happened: a stray `DATABASE_TEST_URL=…/binance_trading_bot`
 * run truncated the operator's profiles, orders, and history.
 *
 * Test databases are `_test`-suffixed by convention (CI: `binance_trading_bot_test`;
 * local isolation: `binance_test`), so refusing any non-`_test` target makes it
 * impossible for a misconfigured env var to truncate the live database, while
 * every legitimate test database still passes.
 */
export function assertTestDatabaseUrl(url: string): void {
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error('assertTestDatabaseUrl: DATABASE_TEST_URL is not a valid URL');
  }
  if (!dbName.endsWith('_test')) {
    // Mask any credentials before surfacing the URL in the error. Anchor to the
    // LAST `@` before the path so a password containing `@` cannot leak a fragment.
    const safe = url.replace(/^([^:]+:\/\/)[^/]*@/, '$1***@');
    throw new Error(
      `Refusing to run destructive tests against non-test database "${dbName}". ` +
        'DATABASE_TEST_URL must target a database whose name ends with "_test" ' +
        `(e.g. binance_trading_bot_test). Got: ${safe}`,
    );
  }
}
