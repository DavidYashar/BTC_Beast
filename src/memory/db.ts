import pg from 'pg';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const isProduction = process.env.NODE_ENV === 'production';
    let ssl: pg.PoolConfig['ssl'] = false;
    if (isProduction) {
      // Render's managed Postgres uses self-signed certs on internal networking.
      // Pin the CA cert via DATABASE_CA_CERT env var if available; otherwise
      // accept the self-signed cert (connection is still TLS-encrypted).
      const ca = process.env.DATABASE_CA_CERT;
      ssl = ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false };
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      max: 5,                        // serial cron queue means fewer concurrent queries
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      keepAlive: true,               // prevent Render proxy from killing idle sockets
      keepAliveInitialDelayMillis: 10_000,
    });

    // Log pool-level errors (e.g. idle client disconnect) so they don't crash the process
    _pool.on('error', (err) => {
      console.error('[pg-pool] Unexpected idle client error:', err.message);
    });
  }
  return _pool;
}

/** Convenience re-export — lazily initialized. */
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(getPool(), prop, receiver);
  },
});

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
