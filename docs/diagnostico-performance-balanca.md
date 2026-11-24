# Balança: demora e perda de pesagens consecutivas

Relato da loja (Toledo Prix 3 Fit, porta COM, Prt5): a segunda pesagem demora, às vezes o peso demora a aparecer e às vezes não aparece, e é preciso digitar.

> **Estado da homologação: PENDENTE.** A correção foi comprovada com testes automatizados e um **simulador** de porta serial.
> Nada foi testado na balança nem no computador da loja. Não considere o problema resolvido antes da seção 7.

## 1. Causa raiz

| # | O que acontecia (versão `42cbdde`) | Efeito na loja |
|---|---|---|
| 1 | `ENQ` a cada **500 ms** | Cada passo seguinte esperava múltiplos de 500 ms |
| 2 | **Três** leituras iguais para aceitar um peso | 1,0 a 1,5 s depois de o peso já estar estável |
| 3 | **Duas** leituras de prato vazio para liberar a próxima pesagem | Prato vazio por menos de ~1 s não liberava: o copo seguinte **nunca aparecia** |
| 4 | O ciclo era consumido **depois** da gravação no banco, sem dizer qual ciclo | Copo trocado durante a gravação: o prato vazio era ignorado e o **segundo copo se perdia sem aviso** |
| 5 | Quem está no caixa, configuração, caixa aberto e a venda de destino eram consultados em sequência **antes** de ler o peso | Peso retirado nesse intervalo não era lançado |
| 6 | Um `ENQ` a cada intervalo, mesmo com resposta pendente | Sem efeito a 500 ms; acumularia com intervalo menor |
| 7 | A tela lia o estado **850 ms** depois da resposta anterior | Até ~0,9 s a mais para o item aparecer |
| 8 | Porta serial que caía não era reaberta | Balança "offline" até alguém reconectar: digitação manual |

Os itens 3 e 4 explicam o "nem aparece"; os itens 1, 2 e 7 explicam a demora. `tests/scale-consecutive.test.js` reproduz os defeitos com o tempo de produção: os três testes **falham** na `42cbdde` e passam agora.

Não há dados da loja que mostrem qual dos fatores pesa mais lá; o diagnóstico novo (seção 5) permite medir.

## 2. O que mudou

**Leitura serial (`src/scale.js`)**
- `ENQ` a cada **150 ms**, **um pedido por vez**: o próximo só sai depois da resposta ou de 600 ms sem resposta. Resposta atrasada vale para o pedido em espera; quadro sem pedido é ignorado e nunca conta como confirmação.
- **Duas** leituras estáveis e iguais, cada uma de um `ENQ`. Instável, negativo, sobrecarga e inválido continuam sem virar item.
- **Uma** leitura de prato vazio libera a próxima pesagem: zero estável, resíduo até 10 g ou peso negativo (tara). A balança só informa zero estável depois que o prato ficou de fato vazio.
- Porta que cai é reaberta sozinha (1 s, 2 s e depois a cada 5 s). Desconectar pela tela cancela.
- Velocidade, paridade, bits e demais parâmetros seriais **não mudaram**.

**Ciclo físico separado da gravação (`src/server.js`)**
- Máquina do prato: `OFFLINE → WAITING_PRODUCT → STABILIZING → READY → WAITING_REMOVAL → WAITING_PRODUCT`. Ela não espera o banco.
- No instante em que o peso fica pronto, peso, identificador único (`captureId`), pessoa no caixa, configuração, caixa aberto e **venda de destino** são lidos juntos. Retirar o copo, trocar de aba, bloquear ou trocar de pessoa depois disso não muda a pesagem.
- Gravações entram em **fila**, na ordem dos copos. Pagar, descartar, trocar de venda e as outras operações esperam a fila: cobrar no meio de uma gravação é recusado com "a venda mudou".
- Falha em qualquer passo vira **pesagem pendente** (tentar de novo ou descartar), sempre da venda original.
- `consume(captureId)` só afeta o próprio ciclo. O banco continua recusando o mesmo `captureId` duas vezes.
- Peso ou valor **digitado** enquanto há (ou pode haver) um copo no prato retém a pesagem até o prato ficar vazio, para a balança que volta não cobrar de novo.

**Tela (`public/app.js`)**
- `GET /api/scale/state` a cada 200 ms (só na Frente de caixa e na Balança; 1 s nas outras telas), sem requisições sobrepostas e sem consultar vendas. Quando algo foi gravado (`liveKey`), a tela busca o estado completo na hora. O ciclo de 850 ms continua como antes.
- A rota pede só uma sessão (como `/api/state`) e devolve apenas peso, `canSwitch`, `liveKey` e o último erro de lançamento. Nada de caixa: o fechamento cego não muda.

Banco de dados: **sem migração** (continua na versão 8).

## 3. Comparativo de performance (simulador)

Condições: `ENQ` respondido em 35 ms, balança simulada leva 300 ms para estabilizar, SQLite local, tela emulada com os mesmos intervalos do `app.js` de cada versão. Os tempos começam na **primeira leitura estável que a balança poderia informar**; a estabilização é física e não entra. Reproduzir: `node tests/perf/scale-benchmark.js` (ver o cabeçalho do arquivo).

**Latência, 100 pesagens por versão (ms)**

| Medida | Versão | Média | Mediana | P95 | P99 | Máxima |
|---|---|---|---|---|---|---|
| Peso estável → gravado | antes | 1.322 | 1.321 | 1.552 | 1.564 | 1.567 |
| | depois | 277 | 277 | 351 | 368 | 369 |
| Peso estável → na tela | antes | 1.766 | 1.853 | 2.149 | 2.186 | 2.186 |
| | depois | 372 | 378 | 491 | 536 | 554 |
| Copo no prato → gravado (inclui 300 ms físicos de estabilização) | antes | 1.628 | 1.635 | 1.852 | 1.870 | 1.871 |
| | depois | 582 | 584 | 655 | 670 | 672 |

Nas 100 pesagens, com o prato vazio por 1,6 s entre elas, nenhuma versão deixou de registrar. Metas iniciais (registro ≤ 500 ms, carrinho ≤ 750 ms): atendidas **no simulador**.

**Troca rápida: copos registrados em 20 trocas, mesmo peso, por tempo de prato vazio**

| Prato vazio (zero estável) | 100 ms | 200 ms | 300 ms | 500 ms | 700 ms | 1.000 ms | 1.500 ms |
|---|---|---|---|---|---|---|---|
| antes | 0 | 0 | 0 | 0 | 10 | 20 | 20 |
| depois | 16 | 20 | 20 | 20 | 20 | 20 | 20 |

Nenhuma troca gerou item a mais. Os 100 ms não são garantidos (seção 4).

**Próximo copo colocado com a gravação anterior em andamento (3 tentativas por atraso; quantas registraram os dois)**

| Atraso do banco | 100 ms | 500 ms | 1.000 ms | 2.000 ms |
|---|---|---|---|---|
| antes | 3 | 2 | 2 | 0 |
| depois | 3 | 3 | 3 | 3 |

## 4. Limites que o software não resolve

- **Retirada mais curta que a leitura.** Se o prato ficar vazio por menos que o intervalo entre dois `ENQ` (~150 ms), ou se a balança não chegar a informar zero estável (copo trocado "no ar", só `IIIII` entre os dois), não há como saber que é outro copo. Nada é inventado: o segundo copo não é lançado e a tela mostra "Retire o prato para nova pesagem". A retirada deve ser percebida: tire o copo, espere o `0,000`, coloque o próximo.
- **Levantar e recolocar o mesmo copo** depois de a balança mostrar zero é uma nova pesagem (já era assim; agora basta menos tempo). Se isso gerar item repetido na loja, use `PDV_SCALE_EMPTY_READINGS=2`.
- **Tara apertada com um copo já lançado** zera a balança e libera nova pesagem (como antes).
- **Mais produto no mesmo copo**, sem retirar, não gera novo lançamento.
- **PDV reiniciado** com um copo já lançado ainda no prato: o copo é lançado de novo (como antes). Pesagens pendentes ficam só na memória e se perdem no reinício.
- **150 ms na Prix 3 Fit real não foi verificado.** A 2400 baud o par `ENQ` + resposta ocupa ~33 ms da linha, e há um pedido por vez, mas o tempo de resposta do aparelho é desconhecido. Meça (seção 5) antes de reduzir.

## 5. Diagnóstico e logs

- Tela **Balança Toledo** (quem tem `scale.manage`): estado, motivo de não lançar, contadores, tempo de resposta serial, espera pelo banco, gravação, estável→gravado, gravado→tela e últimos eventos.
- **Diagnóstico exportado** (Administração → Manutenção) inclui os mesmos dados.
- **Log técnico** opcional em `logs\balanca.log`: cada `ENQ`, resposta, quadro, peso, contadores, `armed`, `captureId`, transições, bloqueios, tempos, falhas. Rotaciona em 10 MB e guarda 5 arquivos (50 MB no máximo; cerca de 3,5 KB por segundo, ou umas 4 horas). Só dados técnicos: sem nomes, senhas, PIN ou tokens.

Ajustes em `C:\ProgramData\LuminorPDV\config\luminor-pdv.env` (reinicie o PDV). Valor fora da faixa é ignorado e vale o padrão.

| Variável | Padrão | Faixa |
|---|---|---|
| `PDV_SCALE_POLL_MS` | 150 | 100 a 1000 |
| `PDV_SCALE_STABLE_READINGS` | 2 | 2 a 5 |
| `PDV_SCALE_EMPTY_READINGS` | 1 | 1 a 3 |
| `PDV_SCALE_LOG` | false | true / false |

Numa instalação existente o arquivo não ganha as linhas novas sozinho: acrescente a que precisar.

## 6. Testes automatizados

| Cenários | Onde |
|---|---|
| Reprodução do defeito (troca rápida, banco lento, estável→gravado ≤ 500 ms) | `tests/scale-consecutive.test.js` |
| 1–6 primeira, segunda, 100, 1.000, pesos diferentes e iguais | `tests/scale-scenarios.test.js` |
| 7–13 retirada de 100 a 1.000 ms, resíduo 4 g e 10 g, tara, oscilação, 30 s parado, conteúdo alterado | idem |
| 14–17 banco com 100/500/1.000/2.000 ms, retirada durante a gravação, respostas atrasadas/fragmentadas/ausentes, reconexão | idem |
| 18–24 troca de aba, manual × automático, falha e reprocessamento, digitado + balança que volta, cobrança durante a captura, troca de operador, permissões e caixa fechado | idem |
| 25 carrinho e total | idem (100 pesagens) e `tests/open-sales.test.js` |

Os 100 e as 1.000 usam leitura acelerada ou leituras entregues direto ao driver (não o tempo de produção). No cenário 4, 1.000 ciclos não são um teste de várias horas de uso.

Resultado nesta branch: antes das mudanças `npm test` 268/268; depois **300/300** (SQLite) e `npm run test:postgres` (PGlite) 244 aprovados, 0 falhas, 56 pulados. `npm run build:demo` gera a demonstração. O PostgreSQL de um servidor real não foi testado.

Uma expectativa de teste mudou de propósito: `tests/permissions.test.js` passou a incluir `/api/scale/state` entre as rotas que pedem só uma sessão.

## 7. Homologação com a balança física (pendente)

Antes: backup manual, caixa de teste com valores que serão cancelados, `PDV_SCALE_LOG=true`. Anote hora de qualquer falha.

- [ ] Balança conecta na mesma porta e velocidade de antes; peso na tela igual ao do visor.
- [ ] Parada 5 minutos, vazia: diagnóstico sem "sem resposta" crescendo. Anote o tempo de resposta serial (média, P95, máximo). Se o P95 passar de ~100 ms ou houver respostas perdidas, use `PDV_SCALE_POLL_MS=200`.
- [ ] Primeira pesagem depois de abrir o caixa.
- [ ] 30 copos seguidos no ritmo normal da loja: 30 itens, nenhum repetido; compare com uma contagem em papel.
- [ ] 10 copos iguais (mesmo peso) seguidos: 10 itens.
- [ ] Troca o mais rápida que a atendente conseguir, 20 vezes: conte registradas e perdidas; quando perder, a tela deve pedir para retirar o prato.
- [ ] Levantar e recolocar o mesmo copo; encostar no prato e no copo parado; colocar colher/cobertura no copo parado: nenhum item a mais sem a balança mostrar zero.
- [ ] Prato vazio mostrando 0,004 kg libera a próxima; com tara, retirar o copo (negativo) libera.
- [ ] Com a tara usada pela loja, repetir 10 copos.
- [ ] Tirar o cabo USB/serial com um copo já lançado e recolocar: reconecta sozinha em até ~5 s e **não** cobra de novo.
- [ ] Tirar o cabo, colocar um copo, digitar o peso, recolocar o cabo: não cobra de novo.
- [ ] Duas abas de venda: cada copo na venda selecionada; não troca de aba com copo no prato.
- [ ] Cobrar logo depois de colocar um copo; pagamento dividido; impressão do fechamento na Elgin i9.
- [ ] Anotar no diagnóstico "estável → gravado" (meta ≤ 500 ms) e "gravado → tela"; cronometrar copo no prato → item na tela.
- [ ] Um turno completo acompanhado. Conferir o total do fechamento.

A correção só está homologada com todos os itens marcados.

## 8. Atualização

1. Anote a versão instalada. Se a loja estiver numa versão anterior ao pagamento dividido (banco abaixo da versão 8), siga também [pagamento-dividido.md](pagamento-dividido.md): o banco será migrado.
2. Backup manual e chave de recuperação em mãos; feche o caixa.
3. Rode `instalador\instalar.bat` desta versão (faz o backup "antes de atualizar").
4. Confira a balança conectada e faça os itens da seção 7.

Esta correção entrou na `main` **antes da homologação**, por decisão do projeto. Estar na `main` não quer dizer homologada: instale na loja já prevendo a seção 7 e o rollback abaixo.

## 9. Voltar atrás (rollback)

- **Só ajuste:** `PDV_SCALE_POLL_MS=500`, `PDV_SCALE_STABLE_READINGS=3` e `PDV_SCALE_EMPTY_READINGS=2` voltam o ritmo de leitura antigo, mantendo as proteções novas. Reinicie o PDV.
- **Programa anterior** (se ele já era da versão 8 do banco, nada precisa ser restaurado):
  1. `Stop-ScheduledTask -TaskName 'Luminor PDV'` (PowerShell de administrador).
  2. Renomeie `C:\Program Files\LuminorPDV` para `LuminorPDV.nova` e `LuminorPDV.anterior` para `LuminorPDV`.
  3. `Start-ScheduledTask -TaskName 'Luminor PDV'`.
- Se a versão anterior usava um banco **mais antigo** que 8, ela recusa o banco atual: siga o rollback de [pagamento-dividido.md](pagamento-dividido.md) (restaurar o backup de antes da atualização).
