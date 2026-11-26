import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { automaticPoints, check, criterionId, isRecord, publishedResult, validateAnswers, validateDefinition } from './examScoring.js';

const defaultExam = 'seguranca-principios-voo';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const db = 'training_private';
const joined = `FROM ${db}.exam_attempts a JOIN ${db}.exam_versions d USING (exam_id,version)`;
const summaryColumns = `a.id,a.pilot_id,a.exam_id,a.version,a.attempt_number,a.status,a.revision,
  a.assigned_at,a.submitted_at,a.published_at,a.published_by,d.exam->>'titulo' AS title,
  (a.result->>'total_score')::float8 AS total_score`;

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getDetail(client, id, owner, lock = false) {
  const { rows } = await client.query(
    `SELECT ${summaryColumns},a.answers,a.result,a.marks,a.auto_score::float8,d.exam,d.rubric ${joined}
     WHERE a.id=$1 AND ($2::uuid IS NULL OR a.pilot_id=$2) ${lock ? 'FOR UPDATE OF a' : ''}`,
    [id,owner]);
  check(rows[0], 'Tentativa não encontrada.', 404);
  return rows[0];
}

function response(row, admin) {
  const { exam, rubric, marks, auto_score, ...attempt } = row;
  if (!admin) return { attempt, exam };
  const questions = rubric.perguntas.map(q => q.metodo === 'automatico' ? q : ({
    ...q, criterios: q.criterios.map((c,i) => ({ ...c, id: criterionId(q,i) })),
  }));
  return { attempt: { ...attempt, marks: marks || {}, auto_score }, exam, rubric: { ...rubric, perguntas: questions } };
}

export async function loadExamBundle(pool, directory) {
  if (!directory) return;
  const read = async file => JSON.parse(await readFile(join(directory,file),'utf8'));
  const [exam, rubric] = await Promise.all([read('exam.json'),read('rubric.json')]);
  const { id: slug, versao: version } = exam;
  check(slug === defaultExam && Number.isSafeInteger(version) && version > 0, 'Pacote de exame inválido.');
  validateDefinition(exam,rubric,slug,version);
  const { rowCount } = await pool.query(
    `INSERT INTO ${db}.exam_versions(exam_id,version,exam,rubric) VALUES ($1,$2,$3,$4)
     ON CONFLICT (exam_id,version) DO UPDATE SET exam_id=EXCLUDED.exam_id
     WHERE exam_versions.exam=EXCLUDED.exam AND exam_versions.rubric=EXCLUDED.rubric`,
    [slug,version,exam,rubric]);
  check(rowCount, 'Esta versão já existe com outro conteúdo. Publica uma nova versão.',409);
  return { exam_id: slug, version };
}

async function assign(pool, pilotId, actor, requestId) {
  check(typeof requestId === 'string' && uuid.test(requestId), 'Identificador do pedido inválido.');
  return transaction(pool, async client => {
    const { rows: profiles } = await client.query('SELECT role,status FROM profiles WHERE id=$1 FOR UPDATE',[pilotId]);
    check(profiles.length, 'Ficha não encontrada.',404);
    const { rows: requests } = await client.query(
      `SELECT a.id,a.pilot_id FROM ${db}.exam_assignments r JOIN ${db}.exam_attempts a ON a.id=r.attempt_id
       WHERE r.requested_by=$1 AND r.request_id=$2`,[actor,requestId]);
    if (requests.length) {
      check(requests[0].pilot_id === pilotId, 'O pedido já foi usado para outra ficha.',409);
      return response(await getDetail(client,requests[0].id,null),true);
    }
    check(['aluno','student','pilot'].includes(profiles[0].role) && profiles[0].status === 'active',
      'A ficha deve pertencer a um aluno ou piloto activo.');
    const { rows: latest } = await client.query(
      `SELECT id,status,attempt_number FROM ${db}.exam_attempts
       WHERE pilot_id=$1 AND exam_id=$2 ORDER BY attempt_number DESC LIMIT 1`,[pilotId,defaultExam]);
    let attemptId = latest[0]?.id;
    if (!attemptId || latest[0].status === 'published') {
      const { rows } = await client.query(
        `INSERT INTO ${db}.exam_attempts(pilot_id,exam_id,version,attempt_number,assigned_by)
         SELECT $1,exam_id,version,$3,$4 FROM ${db}.exam_versions WHERE exam_id=$2
         ORDER BY version DESC LIMIT 1 RETURNING id`,[pilotId,defaultExam,(latest[0]?.attempt_number || 0)+1,actor]);
      check(rows.length, 'O conteúdo do exame ainda não foi configurado.',503);
      attemptId = rows[0].id;
    }
    const saved = await client.query(
      `INSERT INTO ${db}.exam_assignments(requested_by,request_id,attempt_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING request_id`,[actor,requestId,attemptId]);
    check(saved.rowCount, 'O pedido já foi usado para outra ficha.',409);
    return response(await getDetail(client,attemptId,null),true);
  });
}

function requireRevision(body, current) {
  check(Number.isSafeInteger(body.revision) && body.revision >= 0, 'Identifica a revisão da tentativa.');
  check(body.revision === current, 'A tentativa mudou. Actualiza a página antes de continuar.',409);
}

async function saveStudent(pool, id, owner, body, submit) {
  return transaction(pool,async client => {
    const row = await getDetail(client,id,owner,true);
    validateAnswers(row.exam,body.answers,submit);
    const unchanged = isDeepStrictEqual(row.answers,body.answers);
    if (['submitted','published'].includes(row.status)) {
      check(submit && unchanged,'Esta tentativa já foi entregue.',409);
      return response(row,false);
    }
    if (unchanged && !submit) return response(row,false);
    requireRevision(body,row.revision);
    const score = submit ? automaticPoints(row.rubric,body.answers) : null;
    await client.query(
      `UPDATE ${db}.exam_attempts SET answers=$2, status=$3, auto_score=$4,
       revision=revision+1, submitted_at=CASE WHEN $3='submitted' THEN now() END WHERE id=$1`,
      [id,body.answers,submit ? 'submitted' : 'draft',score]);
    return response(await getDetail(client,id,owner),false);
  });
}

async function publish(pool,id,actor,body) {
  return transaction(pool,async client => {
    const row = await getDetail(client,id,null,true);
    check(['submitted','published'].includes(row.status),'Aguarda a entrega do aluno.',409);
    const result = publishedResult(row.exam,row.rubric,row.answers,body.marks,body.feedback ?? '');
    if (row.status === 'published') {
      check(isDeepStrictEqual(row.marks,body.marks) && isDeepStrictEqual(row.result,result),
        'Esta tentativa já tem resultado publicado.',409);
      return response(row,true);
    }
    requireRevision(body,row.revision);
    await client.query(
      `UPDATE ${db}.exam_attempts SET marks=$2,result=$3,published_by=$4,status='published',
       published_at=now(),revision=revision+1 WHERE id=$1`,[id,body.marks,result,actor]);
    return response(await getDetail(client,id,null),true);
  });
}

/** Private API; this data is never exposed through generic PostgREST or the public pilot profile. */
export function examHandler({ pool, authenticate, requireActiveAdmin, jsonBody, send }) {
  return async function handle(req,res,path,headers) {
    const admin = path.startsWith('/admin/');
    const auth = admin ? await requireActiveAdmin(req) : await authenticate(req);
    if (!admin) {
      const active = await pool.query("SELECT 1 FROM profiles WHERE id=$1 AND status='active'",[auth.sub]);
      check(active.rowCount, 'Esta ficha não está activa.',403);
    }
    const verb = req.method;
    const reply = (data,status=200) => send(res,status,data,{ ...headers, 'Cache-Control':'no-store' });
    async function readBody(limit = 512000) {
      const body = await jsonBody(req,limit);
      check(isRecord(body),'Pedido inválido.');
      return body;
    }
    const byPilot = /^\/admin\/exams\/pilots\/([^/]+)\/attempts$/.exec(path);
    if (byPilot) check(uuid.test(byPilot[1]), 'Ficha não encontrada.',404);
    if (byPilot && verb === 'POST') {
      const body = await readBody(4096);
      return reply(await assign(pool,byPilot[1].toLowerCase(),auth.sub,body.request_id));
    }
    if ((byPilot || path === '/exams/attempts') && verb === 'GET') {
      const { rows } = await pool.query(
        `SELECT ${summaryColumns} ${joined} WHERE a.pilot_id=$1 ORDER BY a.assigned_at DESC,a.id DESC`,
        [byPilot ? byPilot[1] : auth.sub]);
      return reply({ attempts: rows });
    }
    const detail = /^(?:\/admin)?\/exams\/attempts\/([^/]+)(?:\/(draft|submit|publish))?$/.exec(path);
    check(detail && uuid.test(detail[1]), 'Recurso não encontrado.',404);
    const [,id,action] = detail;
    if (!action && verb === 'GET') return reply(response(await getDetail(pool,id,admin ? null : auth.sub),admin));
    if (!admin && ((action === 'draft' && verb === 'PUT') || (action === 'submit' && verb === 'POST')))
      return reply(await saveStudent(pool,id,auth.sub,await readBody(),action === 'submit'));
    if (admin && action === 'publish' && verb === 'POST')
      return reply(await publish(pool,id,auth.sub,await readBody()));
    return reply({ message:'Recurso não encontrado.' },404);
  };
}
