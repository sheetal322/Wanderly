/** A dedicated database, dropped and re-migrated on every integration run. */
export function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ?? 'postgres://wanderly:wanderly@localhost:5432/wanderly_test'
  );
}
