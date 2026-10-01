import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [server, migration] = await Promise.all([
  readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  readFile(new URL('../db/009_guest_booking_clients.sql', import.meta.url), 'utf8'),
]);

test('guest booking is public, pending and commits the client with the booking', () => {
  assert.match(server, /url\.pathname === '\/bookings\/guest'/);
  assert.match(server, /async function createGuestBooking/);
  assert.match(server, /'pending'/);
  assert.match(server, /await client\.query\('BEGIN'\)/);
  assert.match(server, /await client\.query\('COMMIT'\)/);
  assert.match(server, /await client\.query\('ROLLBACK'\)/);
  assert.match(server, /INSERT INTO platform_users/);
  assert.match(server, /INSERT INTO profiles/);
  assert.match(migration, /guest_booking_at/);
});

test('a guest contact can complete registration only after code verification', () => {
  assert.match(server, /guest_booking_at=NULL/);
  assert.match(server, /password_hash=\$4/);
  assert.match(server, /platform_signup_challenges/);
});
