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
    cookieSecure: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE === undefined && (env.NODE_ENV ?? 'development') === 'production')
  };
}
