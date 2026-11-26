import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticPoints, publishedResult, validateAnswers, validateDefinition } from '../src/examScoring.js';

import { exam, rubric } from '../fixtures/exam-example.mjs';

test('versions, criteria and public question fields agree before import', () => {
  validateDefinition(exam,rubric,exam.id,1);
  assert.throws(() => validateDefinition(exam,rubric,exam.id,2));
  assert.throws(() => validateDefinition({ ...exam, perguntas:[{ ...exam.perguntas[0], opcao_correcta:'second' },exam.perguntas[1]] },rubric,exam.id,1));
  assert.throws(() => validateDefinition(exam,{ ...rubric,cotacao_manual:2 },exam.id,1));
  const inconsistent = structuredClone(rubric);
  inconsistent.perguntas[1].criterios[0].campo='missing';
  assert.throws(() => validateDefinition(exam,inconsistent,exam.id,1));
});

test('draft validation accepts partial responses and submission requires a complete known form', () => {
  validateAnswers(exam,{});
  validateAnswers(exam,{ choice:'first',writing:'  ' });
  assert.throws(() => validateAnswers(exam,{ choice:'other' }));
  assert.throws(() => validateAnswers(exam,{ choice:'first',writing:'  ' },true));
  assert.throws(() => validateAnswers(exam,{ unknown:'x' }));
  assert.throws(() => validateAnswers(exam,{ writing:'x'.repeat(4001) }));
  validateAnswers(exam,{ choice:'first',writing:'Uma resposta.' },true);
});

test('server computes score per question and section; fractional or missing criteria are checked', () => {
  const answers = { choice:'second', writing:'Exemplo' };
  const marks = { 'written.1':0.5, 'written.2':0 };
  assert.equal(automaticPoints(rubric,answers),1);
  assert.deepEqual(publishedResult(exam,rubric,answers,marks,' Rever. '),{
    auto_score:1,manual_score:0.5,total_score:1.5,sections:{ a:1.5 },questions:{ choice:1,written:0.5 },feedback:'Rever.',
  });
  for (const invalid of [{},{ ...marks, 'written.1':1 },{ ...marks,'written.1':-0.5 },{ ...marks,'written.1':'0.5' },
    { ...marks,'written.1':0.25 },{ ...marks, extra:0 }]) assert.throws(() => publishedResult(exam,rubric,answers,invalid,''));
});
