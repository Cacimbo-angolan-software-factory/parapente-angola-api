import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function sendWhatsApp');
const end = source.indexOf('async function getPublicLicense', start);
assert.ok(start >= 0 && end > start);
const implementation = source.slice(start, end);

function bridge(fetch, token = 'test-token') {
  return runInNewContext(`${implementation}\nsendWhatsApp`, {
    fetch, whatsappEndpoint: 'https://cacimboweb.com/api/integrations/parapente-angola/whatsapp/send',
    whatsappApiToken: token,
  });
}

test('signup OTP uses the authenticated Cacimbo template bridge', async () => {
  let request;
  const send = bridge(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 202, json: async () => ({ status: 'accepted', provider_message_id: 'wamid.test' }) };
  });
  await send('244930120001', 'ignored body', { purpose: 'verification', code: '123456' });
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    message_body: 'ignored body', number: '244930120001', purpose: 'verification', code: '123456',
  });
});

test('Meta rejection is not reported as a successful delivery', async () => {
  const send = bridge(async () => ({
    ok: false, status: 502, json: async () => ({ message: 'Meta rejected message' }),
  }));
  await assert.rejects(send('244930120001', 'test'), /returned 502/);
});
