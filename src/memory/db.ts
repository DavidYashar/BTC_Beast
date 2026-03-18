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
      max: 2,                        // Keep low — Render basic-256mb proxy chokes on parallel auth
      idleTimeoutMillis: 10_000,      // release idle connections faster (Render kills them anyway)
      connectionTimeoutMillis: 15_000, // give Render proxy more time to handshake
      statement_timeout: 30_000,
      allowExitOnIdle: true,          // let pool drain fully when idle — avoids stale sockets
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

/**
 * Force-reset the pool — destroys all connections and creates a fresh pool.
 * Use when connections are suspected stale (e.g. after repeated timeouts).
 * pool.end() is capped at 5 s — zombie connections from Render's PG proxy
 * can make it hang forever, which kills the tick loop.
 */
export async function resetPool(): Promise<void> {
  if (_pool) {
    const dyingPool = _pool;
    _pool = null; // detach immediately so new queries get a fresh pool
    try {
      await Promise.race([
        dyingPool.end(),
        new Promise<void>((resolve) => setTimeout(() => {
          console.warn('[pg-pool] pool.end() timed out after 5 s — abandoning old pool');
          resolve();
        }, 5_000)),
      ]);
    } catch { /* ignore */ }
  }
}

/**
 * Verify PG connectivity with a lightweight probe.
 * On failure, resets the pool and retries once with a fresh connection.
 * Returns true if PG is reachable, false otherwise.
 */
export async function warmDb(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch (err: any) {
    console.warn(`[pg-pool] Connection probe failed: ${err.message}. Resetting pool...`);
    await resetPool();
    try {
      await getPool().query('SELECT 1');
      console.log('[pg-pool] Reconnected after pool reset.');
      return true;
    } catch (retryErr: any) {
      console.error(`[pg-pool] Reconnect failed: ${retryErr.message}. PG unreachable.`);
      return false;
    }
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
