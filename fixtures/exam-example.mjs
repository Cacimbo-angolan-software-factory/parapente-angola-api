// Synthetic questions exclusively for API tests.
export const exam = {
  id: 'seguranca-principios-voo', versao: 1, titulo: 'Ficha de teste', curso: 'Exemplo', idioma: 'pt',
  duracao_indicativa_minutos: 2, cotacao_total: 2, instrucoes: ['Exemplo.'],
  seccoes: [{ id:'a', titulo:'Exemplo', cotacao:2 }],
  perguntas:[
    { id:'choice',numero:1,seccao:'a',cotacao:1,tipo:'escolha_unica',enunciado:'Escolha no teste',
      opcoes:[{ id:'first',texto:'Primeira' },{ id:'second',texto:'Segunda' }] },
    { id:'written',numero:2,seccao:'a',cotacao:1,tipo:'resposta_aberta',enunciado:'Resposta de teste',
      campos:[{ id:'writing',titulo:'Explicação' }] },
  ],
};
export const rubric = {
  exame_id:exam.id,versao:1,cotacao_total:2,cotacao_automatica:1,cotacao_manual:1,
  perguntas:[
    { id:'choice',cotacao:1,metodo:'automatico',opcao_correcta:'second' },
    { id:'written',cotacao:1,metodo:'instrutor',criterios:[
      { campo:'writing',cotacao:0.5,criterio:'Primeiro critério fictício' },
      { campo:'writing',cotacao:0.5,criterio:'Segundo critério fictício' },
    ] },
  ],
};

