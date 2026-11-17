import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';

const dsn = new URL(process.env.DATABASE_URL);
assert.equal(dsn.pathname, '/parapente_commerce_qa');
assert.match(dsn.hostname, /^parapente-commerce-qa-db-/);
const db = new pg.Pool({ connectionString: dsn.href });
const base = 'http://127.0.0.1:8080';
const route = '/admin/commerce';

async function token(role, status) {
  const id = randomUUID();
  await db.query('INSERT INTO platform_users (id,email,role) VALUES ($1,$2,$3)', [id, `${id}@example.invalid`, role === 'Administrador' ? 'admin' : role]);
  await db.query('INSERT INTO profiles (id,name,role,status) VALUES ($1,$2,$3,$4)', [id, 'Fixture', role, status]);
  return new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setSubject(id)
    .setIssuer('parapente-angola-api').setAudience('parapente-angola').setExpirationTime('10m')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function request(path, method, auth, body) {
  const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
  return { status: response.status, data: await response.json() };
}
async function expect(path, status, options = {}) {
  const result = await request(path, options.method || 'GET', options.auth, options.body);
  assert.equal(result.status, status, `${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}

try {
  const admin = await token('Administrador', 'active');
  const pilot = await token('pilot', 'active');
  const inactive = await token('Administrador', 'inactive');
  assert.equal((await expect('/catalog/courses', 200)).show_price_table, false);
  for (const auth of [pilot, inactive]) await expect(`${route}/orders`, 403, { auth });
  await expect(`${route}/orders`, 401);
  const offer = {
    name: 'Curso QA', description: 'Curso de teste', price_minor: 120050, per_lesson: false, visible: false, position: 0,
    images: Array.from({ length: 5 }, (_, index) => `/media/course-images/catalog/qa_${index}.png`),
  };
  await expect(`${route}/courses/course1`, 200, { auth: admin, method: 'PUT', body: offer });
  assert.deepEqual((await expect('/catalog/courses', 200)).hidden_defaults, ['course1']);
  await expect(`${route}/courses/course1`, 200, { auth: admin, method: 'PUT', body: { ...offer, visible: true } });
  await expect(`${route}/course-settings`, 200, { auth: admin, method: 'PUT', body: { show_price_table: true } });
  const courses = await expect('/catalog/courses', 200);
  assert.equal(courses.show_price_table, true);
  assert.deepEqual(courses.offers[0].images, offer.images);

  const product = await expect(`${route}/products`, 201, { auth: admin, method: 'POST',
    body: { name: 'Capacete QA', description: '', category: 'Equipamentos', stock: 1, images: [], visible: true, price_minor: 2250050 } });
  assert.equal((await expect('/catalog/products', 200))[0].stock, undefined);
  const checkout = { request_id: randomUUID(), customer_name: 'Cliente QA', customer_phone: '923123456',
    items: [{ product_id: product.id, quantity: 1 }], expected_total_minor: product.price_minor };
  const newOrder = () => request('/catalog/orders', 'POST', undefined, checkout);
  const repeated = await Promise.all([newOrder(), newOrder()]);
  assert.deepEqual(repeated.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(repeated[0].data, repeated[1].data);
  const first = repeated[0].data;
  const second = await expect('/catalog/orders', 201, { method: 'POST',
    body: { ...checkout, request_id: randomUUID(), customer_phone: '923123457' } });
  const confirm = ({ id }) => request(`${route}/orders/${id}/status`, 'PATCH', admin, { status: 'confirmed' });
  const confirmations = await Promise.all([confirm(first), confirm(second)]);
  assert.deepEqual(confirmations.map(result => result.status).sort(), [200, 409]);
  assert.equal((await expect('/catalog/products', 200))[0].available, false);
  const winner = confirmations[0].status === 200 ? first : second;
  await expect(`${route}/orders/${winner.id}/status`, 200, { auth: admin, method: 'PATCH', body: { status: 'cancelled' } });
  assert.equal((await expect('/catalog/products', 200))[0].available, true);
  assert.equal((await expect(`${route}/orders`, 200, { auth: admin })).orders.length, 2);
  assert.equal((await db.query("SELECT has_schema_privilege('web_service','platform_commerce','USAGE') AS allowed")).rows[0].allowed, false);
  console.log('PostgreSQL 17 QA: roles, migration, publication, simultaneous order retries, concurrent stock reservation and rollback passed.');
} finally {
  await db.end();
}
