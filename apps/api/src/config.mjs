export function loadConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 4000),
    appOrigin: env.APP_ORIGIN ?? `http://localhost:${env.PORT ?? 4000}`,
    databaseUrl: env.DATABASE_URL ?? '',
    sessionCookieName: env.SESSION_COOKIE_NAME ?? 'relay_session',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 168),
    alertIngestKey: env.ALERT_INGEST_KEY ?? '',
    integrationEncryptionKey: env.INTEGRATION_ENCRYPTION_KEY ?? '',
    staticDir: env.RELAY_STATIC_DIR ?? new URL('../../web/public/', import.meta.url).pathname,
    trustProxy: env.TRUST_PROXY === 'true',
    // Durable delivery worker. The lifecycle is owned by the server process;
    // the core (`processDueWork`) is driven directly by the qualification tests.
    workerEnabled: env.RELAY_WORKER_ENABLED !== 'false',
    workerIntervalMs: Number(env.RELAY_WORKER_INTERVAL_MS ?? 15_000),
    workerBatchSize: Number(env.RELAY_WORKER_BATCH_SIZE ?? 20),
    workerLeaseSeconds: Number(env.RELAY_WORKER_LEASE_SECONDS ?? 120),
    cookieSecure: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE === undefined && (env.NODE_ENV ?? 'development') === 'production')
  };
}
