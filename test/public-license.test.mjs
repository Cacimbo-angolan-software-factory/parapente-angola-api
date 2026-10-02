import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('public licence verification exposes only safe verification fields', () => {
  assert.match(source, /async function getPublicLicense/);
  assert.match(source, /publicLicenseMatch && req\.method === 'GET'/);
  assert.match(source, /holder_name/);
  assert.match(source, /valid_until/);
  assert.match(source, /validity/);
  assert.doesNotMatch(source.match(/async function getPublicLicense[\s\S]*?\n}\n\nasync function/)[0], /numero_identificacao|data_nascimento|endereco|condicoes_medicas/);
});
