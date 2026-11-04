import pg from 'pg';

// int8 columns (credits, costs, ids) fit easily in a double; read them as numbers.
pg.types.setTypeParser(20, (value) => Number(value));

/** @param {string} connectionString */
export function createPool(connectionString, { max = 5 } = {}) {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 10_000 });
}

/**
 * Run `fn` in a transaction on one client.
 * @template T
 * @param {pg.Pool} pool
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
