import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { exam,rubric } from '../fixtures/exam-example.mjs';

test('private exam assignment through publication on an isolated PostgreSQL gateway', {
  skip: !process.env.EXAM_QA_DATABASE_URL, timeout:60000,
}, async () => {
  const database = new URL(process.env.EXAM_QA_DATABASE_URL);
  assert.equal(database.hostname,'127.0.0.1');
  assert.equal(database.pathname,'/parapente_exam_qa');
  const { default: pg } = await import('pg');
  const { SignJWT } = await import('jose');
  const pool = new pg.Pool({ connectionString:database.href });
  const directory = await mkdtemp(join(tmpdir(),'exam-api-'));
  const secret = randomBytes(48).toString('hex');
  const port = Number(process.env.EXAM_QA_PORT || 18983);
  await writeFile(join(directory,'exam.json'), JSON.stringify(exam));
  await writeFile(join(directory,'rubric.json'), JSON.stringify(rubric));
  const child = spawn(process.execPath,['src/server.js'],{
    env:{ ...process.env, DATABASE_URL:database.href, JWT_SECRET:secret, TRAINING_EXAM_BUNDLE_DIR:directory, PORT:String(port),
      CORS_ORIGINS:'', SMTP_ENDPOINT:'', WHATSAPP_ENDPOINT:'', MIGRATION_TOKEN:'' },stdio:['ignore','pipe','pipe'],
  });
  let logs = '';
  child.stdout.on('data',v => { logs += v; });
  child.stderr.on('data',v => { logs += v; });
  const objects = [];
  const call = async (path,token,method='GET',data) => {
    const res = await fetch('http://127.0.0.1:' + port + path,{
      method, headers:{ ...(token ? { Authorization:'Bearer ' + token } : {}),'Content-Type':'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (path !== '/health') assert.equal(res.headers.get('cache-control'),'no-store');
    return { status:res.status, ...await res.json() };
  };
  const create = async (role,status='active') => {
    const id = randomUUID();
    await pool.query('INSERT INTO platform_users(id,email,role) VALUES($1,$2,$3)',[id,id+'@example.invalid',role]);
    objects.push(id);
    await pool.query('INSERT INTO profiles(id,name,role,status) VALUES($1,$2,$3,$4)',[id,'Synthetic test profile',role,status]);
    const token = await new SignJWT({ role }).setProtectedHeader({ alg:'HS256' }).setSubject(id)
      .setIssuer('parapente-angola-api').setAudience('parapente-angola').setIssuedAt().setExpirationTime('10m')
      .sign(new TextEncoder().encode(secret));
    return { id,token };
  };
  try {
    for (let tries=0; tries<90; tries++) {
      if (child.exitCode !== null) throw new Error(logs);
      if (await call('/health').then(r => r.status === 200).catch(() => false)) break;
      await sleep(125);
    }
    assert.match(logs,/listening/,logs);
    const admin = await create('admin'), student = await create('aluno'), other = await create('pilot');
    const inactive = await create('admin','inactive');
    const adminList = '/admin/exams/pilots/' + student.id + '/attempts';
    const req = { request_id:randomUUID() };
    assert.equal((await call(adminList)).status,401);
    assert.equal((await call(adminList,inactive.token)).status,403);
    assert.equal((await call(adminList,student.token,'POST',req)).status,403);
    const assigned = await Promise.all([call(adminList,admin.token,'POST',req),call(adminList,admin.token,'POST',{ request_id:randomUUID() })]);
    const attempt = assigned[0].attempt;
    assert.ok(attempt,JSON.stringify(assigned));
    assert.equal(attempt.id,assigned[1].attempt.id);
    const list = await call('/exams/attempts',student.token);
    assert.deepEqual(list.attempts.map(a => a.id),[attempt.id]);
    assert.equal((await call('/exams/attempts',other.token)).attempts.length,0);
    const path = '/exams/attempts/' + attempt.id, adminPath = '/admin' + path;
    assert.equal((await call(path,other.token)).status,404);
    const detail = await call(path,student.token);
    assert.equal(detail.exam.titulo,exam.titulo);
    assert.equal(detail.rubric,undefined);
    assert.equal(detail.attempt.auto_score,undefined);
    const incomplete = { revision:0,answers:{ choice:'first' } };
    assert.equal((await call(path + '/submit',student.token,'POST',incomplete)).status,422);
    assert.equal((await call(path + '/draft',other.token,'PUT',incomplete)).status,404);
    const draft = await call(path + '/draft',student.token,'PUT',incomplete);
    assert.equal(draft.attempt.revision,1);
    assert.equal((await call(path + '/draft',student.token,'PUT',incomplete)).attempt.revision,1);
    const body = { revision:0,answers:{ choice:'second',writing:'Resposta de teste.' } };
    assert.equal((await call(path + '/draft',student.token,'PUT',body)).status,409);
    body.revision=1;
    const submitted = await call(path+'/submit',student.token,'POST',body);
    assert.equal(submitted.attempt.status,'submitted',JSON.stringify(submitted));
    assert.equal(submitted.attempt.total_score,null);
    assert.equal((await call(path+'/submit',student.token,'POST',body)).attempt.revision,2);
    assert.equal((await call(path+'/draft',student.token,'PUT',incomplete)).status,409);
    const review = await call(adminPath,admin.token);
    assert.equal(review.attempt.auto_score,1);
    assert.equal(review.rubric.perguntas[1].criterios[0].id,'written.1');
    const grade = { revision:2,marks:{ 'written.1':0.5,'written.2':0 },feedback:'Rever o exemplo.' };
    assert.equal((await call(adminPath+'/publish',student.token,'POST',grade)).status,403);
    const published = await call(adminPath+'/publish',admin.token,'POST',grade);
    assert.equal(published.attempt.status,'published',JSON.stringify(published));
    assert.equal((await call(adminPath+'/publish',admin.token,'POST',grade)).attempt.revision,3);
    const released = await call(path,student.token);
    assert.equal(released.attempt.result.total_score,1.5);
    assert.equal(released.attempt.result.feedback,grade.feedback);
    assert.equal(released.attempt.marks,undefined);
    assert.equal((await call(adminList,admin.token,'POST',req)).attempt.id,attempt.id);
    const retry = await call(adminList,admin.token,'POST',{ request_id:randomUUID() });
    assert.equal(retry.attempt.attempt_number,2);
    assert.equal((await call('/exams/attempts',student.token)).attempts.length,2);
    const { rows } = await pool.query(`SELECT has_schema_privilege('web_anon','training_private','USAGE') AS anon,
      has_schema_privilege('web_service','training_private','USAGE') AS service`);
    assert.deepEqual(rows[0],{ anon:false,service:false });
  } finally {
    if (child.exitCode === null && child.kill()) await once(child,'exit');
    if (objects.length) await pool.query('DELETE FROM platform_users WHERE id=ANY($1::uuid[])',[objects]);
    await pool.end();
    await rm(directory,{ recursive:true,force:true });
  }
});
