// Synthetic, deterministic input. No database, account, network or secret access.
export function fixture(count = 1000) {
  return {
    schemaVersion: 1, organizationId: 'synthetic-acme', exportedAt: '2026-09-29T00:00:00.000Z',
    incidents: Array.from({ length: count }, (_, i) => ({
      id: `incident-${String(i).padStart(6, '0')}`, organizationId: 'synthetic-acme',
      title: `${['Database latency', 'Payment outage', 'Queue backlog', 'API timeout'][i % 4]} ${i}`,
      severity: `SEV${i % 4 + 1}`, status: 'RESOLVED', startedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      updates: [
        { isPublic: true, message: `Region ${i % 8} recovered after mitigation. ${i % 4 === 0 ? 'Database connection pool restored.' : 'Service health restored.'} Request reference ${i}.` },
        { isPublic: false, message: 'PRIVATE_UPDATE_SENTINEL' }
      ],
      secretEncrypted: 'PRIVATE_SECRET_SENTINEL', timeline: ['PRIVATE_TIMELINE_SENTINEL']
    }))
  };
}
