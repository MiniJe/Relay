import { migratePostgres } from './postgres-store.mjs';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const result = await migratePostgres(databaseUrl);
console.log(result.applied.length ? `Applied migrations: ${result.applied.join(', ')}` : 'Database already up to date.');
