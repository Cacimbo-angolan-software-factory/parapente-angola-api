import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const notificationSource = source.slice(source.indexOf('const bookingPaymentAccounts'), source.indexOf('async function deliverBookingNotification'));
const normalizeSource = source.match(/function normalizePhone[\s\S]*?\n}/)[0];
const escapeSource = source.match(/function escapeHtml[\s\S]*?\n}/)[0];
function setup(row, failWhatsApp = false) {
  const calls = [];
  const context = vm.createContext({
    pool: { query: async () => ({ rows: [row] }) },
    sendWhatsApp: async (...args) => { calls.push(['whatsapp', ...args]); if (failWhatsApp) throw Error('offline'); },
    sendEmail: async (...args) => { calls.push(['email', ...args]); },
    console: { error() {} },
  });
  vm.runInContext(normalizeSource + '\n' + escapeSource + '\n' + notificationSource, context);
  return { calls, deliver: context.deliverClientBookingNotification };
}
const accounts = ['004000004558016710160', '005100006517668014141', '000600002783826830151', '005500006492479310166', '000500003532051410197', '930120001'];
test('guest receives all payment details on both available channels', async () => {
  const { calls, deliver } = setup({ booking_code: 'PA-123', client_details: { name: '<Cliente>', phone: '930120002', email: 'client@example.com' } });
  await deliver({ id: 'booking-1' }, 'created');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], '244930120002');
  for (const account of accounts) {
    assert.ok(calls[0][2].includes(account));
    assert.ok(calls[1][3].includes(account));
  }
  assert.ok(calls[1][3].includes('&lt;Cliente&gt;'));
  assert.ok(calls[0][2].includes('PA-123'));
});
test('registered and agent clients use profile contact details', async () => {
  const { calls, deliver } = setup({ client_name: 'Cliente', client_phone: '244930120002', client_email: 'client@example.com' });
  await deliver({ id: 'booking-2', agent_id: 'agent-1' }, 'created');
  assert.equal(calls.length, 2);
});
test('updates and deletions do not resend payment messages', async () => {
  const { calls, deliver } = setup({});
  for (const action of ['updated', 'deleted']) await deliver({ id: 'booking-3' }, action);
  assert.equal(calls.length, 0);
});
test('email still delivers when WhatsApp fails', async () => {
  const { calls, deliver } = setup({ client_phone: '930120002', client_email: 'client@example.com' }, true);
  await deliver({ id: 'booking-4' }, 'created');
  assert.equal(calls.filter(([channel]) => channel === 'email').length, 1);
});
test('synthetic WhatsApp emails are excluded', async () => {
  const { calls, deliver } = setup({ client_phone: '930120002', client_email: '244930120002@whatsapp.parapenteangola.invalid' });
  await deliver({ id: 'booking-5' }, 'created');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'whatsapp');
});
