import { listMigrationFiles, migratePostgres } from './postgres-store.mjs';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const result = await migratePostgres(databaseUrl);
const available = result.available ?? await listMigrationFiles();
if (result.applied.length) console.log(`Applied migrations: ${result.applied.join(', ')}`);
else console.log('Database already up to date.');
if (result.unknown?.length) {
  console.warn(`Warning: schema_migrations references files not shipped with this release: ${result.unknown.join(', ')}`);
}
console.log(`Known migrations: ${available.join(', ')}`);
