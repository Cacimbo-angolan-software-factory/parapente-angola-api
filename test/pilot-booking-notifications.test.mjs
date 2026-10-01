import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('booking changes dispatch an independent pilot notification', () => {
  assert.match(source, /deliverPilotBookingNotification\(booking, action\)/);
  assert.match(source, /if \(!booking\?\.id \|\| !booking\?\.provider_id\) return/);
});

test('pilot notifications use both Cacimbo WhatsApp and email when configured', () => {
  assert.match(source, /deliveries\.push\(sendWhatsApp\(phone/);
  assert.match(source, /deliveries\.push\(sendEmail\(email/);
  assert.match(source, /Promise\.allSettled\(deliveries\)/);
  assert.match(source, /Pilot notification channel failed/);
});

test('pilot receives the useful booking summary and panel link', () => {
  for (const label of ['Cliente:', 'Atividade:', 'Local:', 'Data:', 'Estado:', 'Valor:', 'Consultar:']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /\$\{frontendUrl\}\/pilot/);
});
