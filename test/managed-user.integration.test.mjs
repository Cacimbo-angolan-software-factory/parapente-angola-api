// Explicit opt-in only. Never run against the production database or live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('managed account creation against isolated PostgreSQL and the actual HTTP handler', {
  skip: process.env.PILOT_QA_ENABLED !== '1',
}, async t => {
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.pathname, '/parapente_pilot_qa');
  assert.match(database.hostname, /^parapente-pilot-qa-db-/);
  const { default: pg } = await import('pg');
  const { SignJWT } = await import('jose');
  const pool = new pg.Pool({ connectionString: database.href });
  const base = 'http://127.0.0.1:8080';
  const fixturePassword = 'Isolated-fixture-only-2026';
  const history = [{ level: 'Aluno', reason: 'Registo inicial na plataforma. "Aviação"\nAngola', date: '2026-10-20T00:00:00.000Z' }];
  const tokenFor = (id, role) => new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setSubject(id)
    .setIssuer('parapente-angola-api').setAudience('parapente-angola').setIssuedAt().setExpirationTime('10m')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const fixture = async (role, status = 'active') => {
    const id = randomUUID();
    await pool.query('INSERT INTO platform_users(id,email,role,email_confirmed_at) VALUES($1,$2,$3,now())', [id, `${id}@example.invalid`, role]);
    await pool.query('INSERT INTO profiles(id,name,role,status) VALUES($1,$2,$3,$4)', [id, 'Isolated fixture', role, status]);
    return { id, token: await tokenFor(id, role) };
  };
  const payload = (extra = {}) => ({
    email: `${randomUUID()}@example.invalid`, password: fixturePassword, role: 'pilot',
    profile: { name: 'Piloto de verificação isolada', status: 'active', level: 'Aluno', flight_hours: 0,
      verified: false, price: 0, commission_percent: null, license_validity: null,
      cv: '', fai_id: '', license_number: '', location: null, fai_certificate_url: null,
      license_certificate_url: null, level_history: history }, ...extra,
  });
  const post = async (body, token, route = '/admin/users') => {
    const response = await fetch(`${base}${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const userCount = async () => Number((await pool.query('SELECT count(*) AS count FROM platform_users')).rows[0].count);
  try {
    const admin = await fixture('admin');
    const pilot = await fixture('pilot');
    const inactiveAdmin = await fixture('admin', 'inactive');
    const agent = await fixture('agent');
    for (const [label, token, status] of [
      ['unauthenticated', undefined, 401], ['pilot', pilot.token, 403], ['inactive administrator', inactiveAdmin.token, 403],
    ]) await t.test(`${label} cannot create accounts`, async () => {
      const before = await userCount();
      assert.equal((await post(payload(), token)).status, status);
      assert.equal(await userCount(), before);
    });

    let created;
    await t.test('exact pilot form payload returns 201 and preserves the JSONB array', async () => {
      const input = payload();
      created = await post(input, admin.token);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.user.role, 'pilot');
      const { rows } = await pool.query('SELECT level_history,flight_hours,verified,price FROM profiles WHERE id=$1', [created.body.data.user.id]);
      assert.deepEqual(rows[0].level_history, history);
      assert.equal(rows[0].flight_hours, 0);
      assert.equal(rows[0].verified, false);
      assert.equal(Number(rows[0].price), 0);
    });
    await t.test('empty history and explicit NULL are persisted correctly', async () => {
      for (const value of [[], null]) {
        const input = payload(); input.profile.level_history = value;
        const result = await post(input, admin.token);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const { rows } = await pool.query('SELECT level_history,level_history IS NULL AS is_null FROM profiles WHERE id=$1', [result.body.data.user.id]);
        assert.deepEqual(rows[0].level_history, value);
        assert.equal(rows[0].is_null, value === null);
      }
    });
    await t.test('client creation without history keeps the compatibility endpoint working', async () => {
      const input = payload({ role: 'client' }); delete input.profile.level_history;
      const result = await post(input, admin.token, '/functions/createClient');
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.user.role, 'client');
    });
    await t.test('agents remain limited to clients and retain the scoped relationship', async () => {
      const result = await post(payload(), agent.token);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.user.role, 'client');
      const { rows } = await pool.query('SELECT agent_id FROM agent_clients WHERE client_id=$1', [result.body.data.user.id]);
      assert.equal(rows[0].agent_id, agent.id);
    });
    await t.test('duplicate email returns 409 and does not leave an extra account', async () => {
      const before = await userCount();
      const result = await post(payload({ email: created.body.data.user.email }), admin.token);
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(await userCount(), before);
    });
    await t.test('health and authenticated user lookup remain available', async () => {
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const token = await tokenFor(created.body.data.user.id, 'pilot');
      assert.equal((await fetch(`${base}/auth/user`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    });
  } finally { await pool.end(); }
});
