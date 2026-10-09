import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import pg from 'pg';
import { createApplicationPool } from './client.mjs';

test('application pool sends jit=off at connection startup without changing pool limits', async () => {
  const pool = createApplicationPool({ connectionString: 'postgres://example:example@localhost/example_test', max: 4, idleTimeoutMillis: 1000 });
  try {
    const client = new pg.Client(pool.options);
    assert.equal(client.connectionParameters.options, '-c jit=off');
    assert.equal(pool.options.max, 4);
    assert.equal(pool.options.idleTimeoutMillis, 1000);
  } finally { await pool.end(); }
});

test('URL startup settings are preserved and JIT overrides an earlier jit=on', async () => {
  const connection = new URL('postgres://example:example@localhost/example_test?application_name=pool-test');
  connection.searchParams.set('options', '-c statement_timeout=7500 -c jit=on');
  const pool = createApplicationPool({ connectionString: connection.toString(), options: '-c statement_timeout=1000' });
  try {
    const client = new pg.Client(pool.options);
    assert.equal(client.connectionParameters.options, '-c statement_timeout=7500 -c jit=on -c jit=off');
    assert.equal(client.connectionParameters.application_name, 'pool-test');
  } finally { await pool.end(); }
});

test('explicit startup options take precedence over PGOPTIONS', async () => {
  const previous = process.env.PGOPTIONS;
  process.env.PGOPTIONS = '-c statement_timeout=9000 -c jit=on';
  const pool = createApplicationPool({ connectionString: 'postgres://example:example@localhost/example_test', options: '-c statement_timeout=7500' });
  try {
    assert.equal(new pg.Client(pool.options).connectionParameters.options, '-c statement_timeout=7500 -c jit=off');
  } finally {
    await pool.end();
    if (previous === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previous;
  }
});

test('PGOPTIONS are preserved when no startup settings are supplied', async () => {
  const previous = process.env.PGOPTIONS;
  process.env.PGOPTIONS = '-c statement_timeout=9000 -c jit=on';
  const pool = createApplicationPool({ connectionString: 'postgresql:///example_test?host=%2Ftmp%2Fpostgres' });
  try {
    const client = new pg.Client(pool.options);
    assert.equal(client.connectionParameters.options, '-c statement_timeout=9000 -c jit=on -c jit=off');
    assert.equal(client.connectionParameters.host, '/tmp/postgres');
  } finally {
    await pool.end();
    if (previous === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previous;
  }
});

test('repeated URI options keep pg last-value precedence', async () => {
  const pool = createApplicationPool({ connectionString: 'postgres://example:example@localhost/example_test?options=-c%20statement_timeout%3D1000&options=-c%20statement_timeout%3D7500' });
  try {
    assert.equal(new pg.Client(pool.options).connectionParameters.options, '-c statement_timeout=7500 -c jit=off');
  } finally { await pool.end(); }
});

test('pg socket URI and socket-path connection strings keep their credentials and host', async () => {
  for (const connectionString of ['postgresql://example:socket-test-password@/example_test?host=%2Ftmp%2Fpostgres', '/tmp/postgres example_test']) {
    const expected = new pg.Client({ connectionString }).connectionParameters;
    const pool = createApplicationPool({ connectionString });
    try {
      const actual = new pg.Client(pool.options).connectionParameters;
      for (const key of ['host', 'port', 'database', 'user', 'password', 'ssl']) assert.deepEqual(actual[key], expected[key]);
      assert.equal(actual.options, `${expected.options ?? ''} -c jit=off`.trim());
    } finally { await pool.end(); }
  }
});

test('malformed connection URLs retain pg credential redaction', () => {
  const connectionString = 'postgres://example:private-test-password@localhost:bad/example_test';
  assert.throws(() => createApplicationPool({ connectionString }), error => {
    assert.doesNotMatch(inspect(error), /private-test-password/);
    assert.doesNotMatch(error.stack, /private-test-password/);
    assert.doesNotMatch(JSON.stringify(error), /private-test-password/);
    return true;
  });
});
