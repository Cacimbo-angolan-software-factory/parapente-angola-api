import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { managedProfileValues } from '../src/managedProfile.js';

test('pilot level history is encoded as JSON text, without mutating the profile', () => {
  const history = [{ level: 'Aluno', reason: 'Registo inicial na plataforma. "Aviação"\nAngola', date: '2026-10-20T00:00:00.000Z' }];
  const profile = { name: 'Piloto', role: 'pilot', flight_hours: 0, verified: false, level_history: history };
  const values = managedProfileValues('pilot-id', profile);
  assert.deepEqual(values.slice(0, -1), ['pilot-id', 'Piloto', 'pilot', 0, false]);
  assert.equal(typeof values.at(-1), 'string');
  assert.deepEqual(JSON.parse(values.at(-1)), history);
  assert.equal(profile.level_history, history);
});

test('empty history remains a JSON array, while null remains SQL NULL', () => {
  assert.deepEqual(managedProfileValues('id', { level_history: [] }), ['id', '[]']);
  assert.deepEqual(managedProfileValues('id', { level_history: null }), ['id', null]);
  assert.deepEqual(managedProfileValues('id', { name: 'Cliente', phone: null }), ['id', 'Cliente', null]);
});

test('bound values preserve the column order and do not stringify unrelated fields', () => {
  const profile = { level_history: [{ level: 'Nível 1' }], price: 0, status: 'active', commission_percent: null };
  assert.deepEqual(managedProfileValues('id', profile), ['id', JSON.stringify(profile.level_history), 0, 'active', null]);
});

test('managed account creation uses the JSON-safe bound parameters before opening the transaction', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /const values = managedProfileValues\(id, profile\)/);
  assert.ok(source.indexOf('const values = managedProfileValues(id, profile)') < source.indexOf("await client.query('BEGIN')", source.indexOf('async function createManagedUser')));
});
