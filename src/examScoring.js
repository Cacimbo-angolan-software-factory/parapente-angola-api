const own = (object, key) => Object.hasOwn(object, key);
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function check(condition, message, status = 422) {
  if (!condition) throw Object.assign(new Error(message), { status });
}

const idPattern = /^[a-z][a-z0-9_.-]{0,59}$/i;
const validId = value => typeof value === 'string' && idPattern.test(value) && !(value in Object.prototype);
const halfPoints = value => Number.isSafeInteger(value * 2) && Number.isFinite(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const safeKeys = (object, keys) => isRecord(object) && Object.keys(object).every(key => keys.includes(key));

function uniqueById(items) {
  return Array.isArray(items) && items.length > 0 && items.length <= 100 &&
    items.every(item => isRecord(item) && validId(item.id)) &&
    new Set(items.map(item => item.id)).size === items.length;
}

/** Only the student's document can leave the gateway. Refuse unknown public properties on import. */
export function validateDefinition(exam, rubric, slug, version) {
  const invalid = 'O enunciado e a grelha têm de definir a mesma versão e cotações coerentes.';
  check(safeKeys(exam, ['id','versao','titulo','curso','idioma','duracao_indicativa_minutos','cotacao_total','instrucoes','seccoes','perguntas'])
    && exam.id === slug && exam.versao === version && nonempty(exam.titulo)
    && nonempty(exam.curso) && nonempty(exam.idioma)
    && Number.isSafeInteger(exam.duracao_indicativa_minutos) && exam.duracao_indicativa_minutos > 0
    && Array.isArray(exam.instrucoes) && exam.instrucoes.every(nonempty)
    && uniqueById(exam.seccoes) && uniqueById(exam.perguntas)
    && isRecord(rubric) && rubric.exame_id === slug && rubric.versao === version
    && uniqueById(rubric.perguntas) && rubric.perguntas.length === exam.perguntas.length, invalid);
  const totals = new Map();
  for (const section of exam.seccoes) {
    check(safeKeys(section, ['id','titulo','cotacao','instrucao']) && nonempty(section.titulo)
      && (!own(section,'instrucao') || nonempty(section.instrucao))
      && halfPoints(section.cotacao) && section.cotacao > 0, invalid);
    totals.set(section.id, 0);
  }
  const fields = new Set();
  let automatic = 0, manual = 0;
  for (const question of exam.perguntas) {
    const key = rubric.perguntas.find(item => item.id === question.id);
    check(safeKeys(question, ['id','numero','seccao','cotacao','tipo','enunciado','titulo','opcoes','campos'])
      && Number.isSafeInteger(question.numero) && question.numero > 0 && nonempty(question.enunciado)
      && (!own(question,'titulo') || nonempty(question.titulo))
      && halfPoints(question.cotacao) && question.cotacao > 0 && totals.has(question.seccao)
      && key && key.cotacao === question.cotacao, invalid);
    totals.set(question.seccao, totals.get(question.seccao) + question.cotacao);
    if (question.tipo === 'escolha_unica') {
      check(key.metodo === 'automatico' && !own(question,'campos') && uniqueById(question.opcoes)
        && question.opcoes.length >= 2 && question.opcoes.every(option => safeKeys(option,['id','texto']) && nonempty(option.texto))
        && question.opcoes.some(option => option.id === key.opcao_correcta) && !fields.has(question.id), invalid);
      fields.add(question.id);
      automatic += question.cotacao;
    } else {
      check(['resposta_aberta','caso_pratico'].includes(question.tipo) && !own(question,'opcoes')
        && key.metodo === 'instrutor' && uniqueById(question.campos) && Array.isArray(key.criterios)
        && key.criterios.length > 0 && key.criterios.length <= 100, invalid);
      for (const field of question.campos) {
        check(safeKeys(field,['id','titulo']) && nonempty(field.titulo) && !fields.has(field.id)
          && key.criterios.some(c => c?.campo === field.id), invalid);
        fields.add(field.id);
      }
      check(key.criterios.every(c => isRecord(c) && halfPoints(c.cotacao) && c.cotacao > 0 &&
        question.campos.some(f => f.id === c.campo) && nonempty(c.criterio || c.exemplo_de_resposta))
        && key.criterios.reduce((sum,c) => sum + c.cotacao,0) === question.cotacao, invalid);
      manual += question.cotacao;
    }
  }
  check(exam.seccoes.every(s => totals.get(s.id) === s.cotacao) && automatic === rubric.cotacao_automatica
    && manual === rubric.cotacao_manual && automatic + manual === exam.cotacao_total
    && rubric.cotacao_total === exam.cotacao_total, invalid);
}

export function validateAnswers(exam, answers, complete = false) {
  check(isRecord(answers), 'As respostas devem ser um objecto.');
  const known = new Set();
  for (const question of exam.perguntas) {
    if (question.tipo === 'escolha_unica') {
      known.add(question.id);
      if (own(answers,question.id)) check(question.opcoes.some(o => o.id === answers[question.id]), 'Opção de resposta inválida.');
      else check(!complete, 'Responde a todas as perguntas antes de entregar.');
    } else for (const field of question.campos) {
      known.add(field.id);
      if (own(answers,field.id))
        check(typeof answers[field.id] === 'string' && answers[field.id].length <= 4000 && !answers[field.id].includes('\0'), 'A resposta excede o limite ou contém texto inválido.');
      if (complete) check(nonempty(answers[field.id]), 'Preenche todos os campos antes de entregar.');
    }
  }
  check(Object.keys(answers).every(key => known.has(key)), 'Campo de resposta desconhecido.');
}

export function automaticPoints(rubric, answers) {
  return rubric.perguntas.filter(q => q.metodo === 'automatico').reduce(
    (sum, q) => sum + (answers[q.id] === q.opcao_correcta ? q.cotacao : 0), 0);
}

export const criterionId = (question, index) => question.id + '.' + (index + 1);
export function publishedResult(exam, rubric, answers, marks, feedback) {
  check(isRecord(marks) && typeof feedback === 'string' && feedback.length <= 4000 && !feedback.includes('\0'),
    'Verifica a grelha e o comentário antes de publicar.');
  const sections = Object.fromEntries(exam.seccoes.map(s => [s.id, 0]));
  const questions = {};
  let manual = 0, expected = 0;
  for (const key of rubric.perguntas) {
    let score = 0;
    if (key.metodo === 'automatico') {
      score = answers[key.id] === key.opcao_correcta ? key.cotacao : 0;
    } else {
      key.criterios.forEach((criterion, index) => {
        const mark = marks[criterionId(key,index)];
        check(halfPoints(mark) && mark <= criterion.cotacao, 'Atribui uma pontuação válida a cada critério.');
        score += mark;
        expected++;
      });
      manual += score;
    }
    questions[key.id] = score;
    sections[exam.perguntas.find(q => q.id === key.id).seccao] += score;
  }
  check(Object.keys(marks).length === expected, 'Grelha de pontuação inválida.');
  const auto = automaticPoints(rubric,answers);
  return { auto_score: auto, manual_score: manual, total_score: auto + manual, sections, questions, feedback: feedback.trim() };
}
