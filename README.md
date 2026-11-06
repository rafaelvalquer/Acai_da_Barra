# Luminor PDV — Açaí da Barra (MVP v0.1)

Sistema **local em Node.js** para demonstrar à cliente da Luminor Software um fluxo de pesagem automática, cálculo por quilo, vendas, controle simples de caixa, produtos, estoque unitário e relatórios.

> **Protótipo para demonstração e homologação, NÃO pronto para operação fiscal ou comercial em produção.**
> O protocolo serial foi implementado conforme documentação da Toledo, mas NÃO foi testado na balança física da cliente.

## 1. Hardware realmente fotografado

A etiqueta enviada indica **TOLEDO PRIX3 FIT/2**, fabricação **05/2022**, faixa **6 kg x 2 g e 15 kg x 5 g**. Apesar de ter sido mencionado anteriormente "32 kg", a unidade fotografada tem capacidade **máxima de 15 kg**. A frente mostra 0,004 kg e preço de R$ 64,90/kg (fotografia; pode não ser o preço atual). Não inferir que a porta serial está instalada a partir das fotos: nenhuma foto mostra a conexão física.

O vídeo mostra a operação de um PDV de franquia, sem comprovar integração com a balança. Este protótipo opera independentemente desse sistema.

## 2. Funcionalidades implementadas

**Pesagem e venda**
- Frente de caixa: preço/kg configurável, peso e valor em tempo real, múltiplos itens por venda e pagamento em **dinheiro, Pix, débito ou crédito**. No dinheiro, o funcionário informa o valor recebido (ou toca em "Exato" ou numa nota sugerida) e o **troco aparece na hora**; um valor menor que o total trava o "Cobrar esta venda". O campo é opcional, e recebido e troco ficam gravados na venda. O botão fica travado enquanto a venda é gravada, e cada venda leva um identificador único: um duplo clique nunca gera duas vendas.
- **Vendas simultâneas (abas de atendimento):** cada cliente em atendimento tem sua própria venda, mostrada como uma aba com nome e total. "Nova venda" abre e já seleciona uma venda com nome automático (Venda 01, Venda 02…), que pode ser renomeada ("Família Souza", "Mesa 2"). A balança pesa **só para a venda selecionada** ("Pesando para: …") e a troca de venda fica **bloqueada enquanto há peso no prato**. Itens podem ser transferidos de uma venda para outra (com registro), cada venda é cobrada ou descartada sozinha, e as vendas abertas ficam gravadas no banco: sobrevivem a fechar o navegador ou reiniciar o computador. Veja o passo a passo na seção 2.1.
- Captação do peso com protocolo **Prt5**: comando `ENQ` (`0x05`), resposta `STX` + cinco caracteres + `ETX`; detecta leitura estável, instável, negativa e sobrecarga.
- Captura automática depois de **3 amostras estáveis idênticas**; bloqueia captura dupla e exige **retorno a zero (pelo menos duas leituras)** antes da próxima pesagem. Cada ciclo de pesagem (do prato vazio ao próximo prato vazio) tem um identificador único gravado com o item: o mesmo copo nunca entra duas vezes, nem depois de um pedido repetido ou de reconectar o cabo. Se a gravação de uma pesagem falhar, ela aparece em destaque na tela ("Tentar de novo" ou "Descartar") e nunca some sem aviso.
- Também há captura manual opcional, condicionada a peso estável.
- **Lançamento manual de peso ou valor** (botão "Digitar peso ou valor"): peso em kg (ex.: `0,450`, de 0,001 a 15 kg) calculado pelo preço/kg, ou valor direto em R$. Quando a balança está sem comunicação, o botão fica em destaque ("Balança sem comunicação? Digite o peso"). Itens digitados aparecem com a etiqueta **digitado** no carrinho, no histórico e nos relatórios.
- Correção antes de cobrar: remover item, transferir item para outra venda, descartar a venda (com confirmação) e botões − / + na quantidade de produtos (produto repetido soma na mesma linha).
- Estoque de produtos unitários **reservado** enquanto estão em vendas abertas: duas vendas não conseguem vender a mesma última unidade, e a baixa definitiva acontece na cobrança.
- Simulador sem hardware (0, 250, 420, 840 e 1200 gramas).

**Funcionários e caixa**
- Cadastro de funcionários (incluir, renomear, desativar) e **operador do caixa** escolhido pelo nome no topo da tela, com um toque, sem senha. Abertura, vendas, sangrias, suprimentos, cancelamentos e fechamento registram quem fez.
- Caixa: abertura (com operador), sangria, suprimento e fechamento com comparação entre valor contado e esperado. A sangria não pode ser maior que o dinheiro em caixa.
- O turno aberto mostra o total por forma de pagamento; ao fechar, aparece o **resumo do fechamento** (vendas, cancelamentos, formas de pagamento, fundo, suprimentos, sangrias, esperado, contado e diferença).

**Histórico, cancelamento e relatórios**
- **Histórico de vendas** com filtro por data, situação (concluídas/canceladas) e número da venda; o detalhe mostra itens, pesos, operador, pagamento e horário.
- **Cancelamento** de vendas do caixa aberto, com motivo obrigatório: devolve o estoque dos produtos e tira a venda dos totais e do dinheiro esperado. **Cancelar e corrigir** abre uma venda nova, "Correção #N", com os itens da venda cancelada, para ajustar e cobrar de novo; as outras vendas abertas não mudam. Vendas de caixas já fechados não podem ser canceladas (o fechamento conferido não muda).
- **Relatórios por dia, semana (segunda a domingo) ou mês**, com navegação para períodos anteriores: total, número de vendas, ticket médio, kg vendidos, formas de pagamento, cancelamentos, lançamentos digitados, gráfico por dia (com tabela), vendas por operador e fechamentos de caixa do período. Os dias seguem o horário de Brasília (`LUMINOR_TIMEZONE` para alterar).
- Produtos unitários: cadastro/edição/exclusão, preço, estoque inteiro, baixa automática na venda e devolução ao cancelar.
- Dados persistentes em SQLite local; registros de vendas guardam preços e pesos utilizados no momento da venda. Bancos da versão anterior são atualizados automaticamente na primeira execução, sem perder vendas (vendas antigas aparecem sem operador, "—").

**Fora do escopo do MVP:** NFC-e, SAT/CF-e, integração fiscal, TEF, conciliação automática com adquirente, pagamento dividido entre formas de pagamento, QR Code/comanda impressa, vendas abertas compartilhadas entre vários computadores, senha ou níveis de permissão para funcionários (o operador é identificado só pelo nome), impressora fiscal, estoque por ingredientes/receitas, integração com sistema da franquia e sincronização em nuvem.

### 2.1 Atender vários clientes ao mesmo tempo (manual do funcionário)

1. **Começar:** ao abrir o caixa já existe a "Venda 01" selecionada. A faixa acima da balança mostra as vendas abertas, cada uma com o total; a selecionada aparece em roxo, com o ícone da balança.
2. **Outro cliente chegou:** com o prato vazio, toque em **Nova venda**. Ela já fica selecionada e o cartão da balança mostra "Pesando para: Venda 02". Para dar um nome, toque no nome da venda (no topo do carrinho ou na aba selecionada), digite e confirme com Enter; Esc cancela.
3. **Pesar:** coloque o copo; o peso entra sozinho **na venda selecionada**. Para pesar para outro cliente, **tire o copo do prato** e toque na aba dele. Com peso no prato, as outras abas ficam apagadas e aparece "Retire o produto da balança para trocar de venda.". Isso impede que o copo de um cliente vá para a conta de outro.
4. **Item na venda errada:** no carrinho, toque no botão de transferir (setas) ao lado do item, escolha a venda de destino (ou "Nova venda") e confirme. A transferência fica registrada nas duas vendas.
5. **Cobrar:** selecione a venda do cliente que vai pagar, confira o total em "Cobrar esta venda · R$ …", escolha a forma de pagamento e confirme. As outras vendas continuam abertas. Depois da cobrança a balança passa para uma venda vazia, **nunca para a venda de outro cliente**.
6. **Cliente desistiu:** com a venda selecionada, toque em **Descartar venda** e confirme. Nada é cobrado e as outras vendas não mudam.
7. **Sem balança:** com a balança desligada ou desconectada, dá para trocar de venda livremente e usar "Digitar peso ou valor", que lança na venda selecionada (o nome aparece na janela).
8. **Fechar o caixa:** só é possível sem vendas com itens esperando cobrança. A aba Movimentação de caixa lista as que faltam ("Existem N vendas em aberto"); toque em cada uma para abrir, cobre ou descarte. Abas vazias são fechadas junto com o caixa.

No teclado, as setas ←/→, Home e End percorrem as abas, e Enter ou espaço seleciona. A tela foi conferida em monitores de 1366×768 (tudo cabe sem rolar, incluindo o "Cobrar") e no celular, onde as abas viram uma lista.

## 3. Como executar em Windows

1. Instalar **Node.js 22.13 ou superior** (foi testado com Node 22.16).
2. Descompactar o projeto em uma pasta com permissão de escrita.
3. Dentro da pasta, executar no terminal:

   ```bat
   node src\server.js
   ```

   Ou clicar em `iniciar-windows.bat`.
4. Abrir `http://127.0.0.1:3187` em Chrome, Edge ou Firefox.
5. Na aba **Funcionários**, cadastrar quem vai operar o caixa.
6. Na aba **Movimentação de caixa**, escolher o operador e abrir o turno.
7. Na aba **Balança Toledo**, ativar o modo demonstração.
8. Simular 840 g; retornar a 0 g; simular 420 g; verificar que foram lançados **dois itens**.
9. Na **Frente de caixa**, ajustar o preço por kg, incluir produtos unitários (se cadastrados) ou digitar um peso/valor, escolher a forma de pagamento e cobrar a venda.
   Para testar vendas simultâneas: com o prato em 0 g, toque em **Nova venda**, simule outro peso, volte à primeira aba e cobre as duas em qualquer ordem.
10. Conferir o **Histórico de vendas** e os **Relatórios** e fechar o caixa.

Variáveis opcionais: `PORT` (padrão 3187), `LUMINOR_DATA_DIR` (pasta do banco, padrão `data/`) e `LUMINOR_TIMEZONE` (padrão `America/Sao_Paulo`).

A execução do simulador, a interface e o banco usam apenas o Node.js, **sem npm install**.

**Preço de demonstração:** R$ 64,90/kg, inspirado na fotografia enviada. **É preciso confirmar o preço praticado** antes da primeira operação.

## 4. Como habilitar a balança física

A comunicação serial real depende de um acessório/interface compatível instalado na Prix 3 Fit e configurado para o computador. Pela documentação, a linha pode oferecer RS-232C, USB ou Bluetooth; depende de modelo/firmware e acessórios.

1. Confirmar fisicamente a interface existente e o cabo/conversor adequado, com técnico ou suporte Toledo.
2. Instalar o driver do conversor serial USB, quando aplicável, e identificar a porta COM no Windows.
3. Instalar a biblioteca serial:

   ```bat
   npm install
   ```

   O projeto inclui `serialport` como dependência opcional: se não estiver instalada, o modo demonstração continua funcionando.
4. Consultar o manual **da versão exata da balança** e configurar o protocolo `Prt5` e a velocidade da porta. Em modelos compatíveis, parâmetros como `C14` e `C15` tratam o protocolo e a velocidade. O padrão 2400 baud é oferecido como seleção inicial no protótipo, mas **não está garantido** para a unidade da cliente.
5. Na aba **Balança**, clicar em "Buscar portas COM", selecionar a porta, velocidade e "Conectar".
6. Validar todas as situações com pesos padrões e comparar peso mostrado na balança, peso recebido e valor calculado.

O protocolo Prt5, documentado no manual do fabricante, responde à solicitação `ENQ` com:

| Payload | Significado |
| --- | --- |
| `00840` | 0,840 kg |
| `IIIII` | Peso instável |
| `NNNNN` | Peso negativo |
| `SSSSS` | Sobrecarga |

O software **nunca tenta alterar a calibração, tara ou parâmetros metrológicos**, nem exige abertura do equipamento ou remoção de lacres. Configurações físicas devem ser acompanhadas por profissional habilitado, conforme as condições de uso.

### Fontes técnicas oficiais

- Produto Toledo Prix 3 Fit: https://www.toledobrasil.com/produto/prix-3-fit
- Manual do usuário 3 Fit (Rev. 14, protocolo Prt5 seção 5.3.4): https://www.toledobrasil.com/wp-content/uploads/2024/08/MU-3-Fit-01-25-Rev.-14.pdf
- Portaria Inmetro nº 157/2022 (instrumentos de pesagem não automáticos): https://www.gov.br/inmetro/pt-br/acesso-a-informacao/perguntas-frequentes/metrologia-legal/balanca/qual-o-campo-de-aplicacao-do-rtm-para-balanca-port23694

## 5. Importante: conformidade metrológica e fiscal

O manual Toledo inclui orientação específica para **balanças em automação de pontos de venda**, com necessidade de apreciação/autorização prévia pelo órgão metrológico conforme o enquadramento aplicável. **Verificar com Toledo e IPEM/Inmetro antes da implantação real**, especialmente a integração da indicação do peso e a comercialização por peso. A homologação e o uso legal não foram avaliados nem concluídos neste MVP.

O sistema **não emite nota fiscal ou cupom fiscal**, nem substitui PDV fiscal homologado. Exige desenvolvimento, validação tributária e adequação local para uso real em vendas.

## 6. Arquitetura

```text
Prix 3 Fit/2 ──(Prt5 por COM, se disponível)──┐
                                            │
Simulador de peso ───────────────────────────┤
                                            ▼
                                    Node.js HTTP (127.0.0.1)
                                      ├─ API local /api/*
                                      ├─ State machine anti-duplicidade
                                      ├─ SQLite transacional
                                      └─ HTML/CSS/JS sem framework
```

- `src/protocol.js`: parser de frames Prt5, conversão de valores e cálculo com centavos inteiros.
- `src/scale.js`: driver serial opcional, simulador, anti-duplicidade e estabilidade.
- `src/db.js`: modelo de dados, migrações numeradas e transações de vendas abertas, vendas, estoque, caixa e relatórios.
- `src/server.js`: servidor HTTP local e API.
- `public/`: interface de frente de caixa e gestão.
- `data/luminor-pdv.sqlite`: banco criado na primeira execução (não incluído no ZIP).
- `tests/`: testes automatizados (regras de venda, balança com porta serial simulada e API HTTP).

### API local

Todas as rotas `POST` exigem o cabeçalho `X-Luminor-Token` obtido em `GET /api/session`.

| Área | Rotas |
| --- | --- |
| Estado e configuração | `GET /api/state`, `POST /api/config` |
| Funcionários | `POST /api/employees/save` `{id?, name}`, `POST /api/employees/remove` `{id}`, `POST /api/operator` `{id}` |
| Caixa | `POST /api/shift/open` `{opening, operatorId}`, `POST /api/shift/move` (sangria/suprimento), `POST /api/shift/close` `{counted}` |
| Vendas abertas | `GET /api/open-sales` (lista e venda selecionada), `POST /api/open-sales/create`, `/api/open-sales/select` `{saleId}`, `/api/open-sales/rename` `{saleId, label}`, `/api/open-sales/discard` `{saleId}`, `/api/open-sales/transfer-item` `{saleId, key, toSaleId}` (`toSaleId: "new"` abre uma venda nova). Criar e selecionar respondem 400 "Retire o produto da balança para trocar de venda." enquanto há peso no prato |
| Itens da venda | `POST /api/cart/weight` `{saleId}` (só a venda selecionada), `/api/cart/unit` `{saleId, id, quantity}`, `/api/cart/manual-weight` `{saleId, weight}`, `/api/cart/manual-value` `{saleId, amount}`, `/api/cart/quantity` `{saleId, key, quantity}`, `/api/cart/remove` `{saleId, key}` |
| Cobrança | `POST /api/checkout` `{saleId, method, uuid, received?, revision?}`: `received` só em dinheiro (a venda devolve `received_cents` e `change_cents`); `revision` é a versão da venda que o funcionário conferiu, e a cobrança é recusada se um item chegou depois. Repetir a cobrança da mesma venda devolve a venda já gravada (`duplicate: true`) |
| Pesagens pendentes | `POST /api/scale/pending/retry` `{captureId}`, `/api/scale/pending/discard` `{captureId}`; `GET /api/state` traz `pendingCaptures` e `canSwitch` |
| Vendas | `GET /api/sales?from=&to=&status=&q=`, `GET /api/sales/detail?id=` (inclui `draft_label`, o nome do atendimento), `POST /api/sales/cancel` `{id, reason}`, `POST /api/sales/correct` `{id, reason}` (devolve `draft`, a venda "Correção #N", e `selected`) |
| Relatórios | `GET /api/report?period=day\|week\|month&date=AAAA-MM-DD` |
| Produtos | `POST /api/products/save`, `POST /api/products/remove` |
| Balança | `GET /api/scale/ports`, `POST /api/scale/connect`, `/api/scale/disconnect`, `/api/scale/demo`, `/api/scale/demo-weight` |

O protótipo utiliza `node:sqlite`, presente no Node.js 22, que ainda emite um **aviso de API experimental** nessa versão. Antes de produção, recomendar migração para driver SQLite estável e rotinas de backup/restore.

**Banco de dados das vendas abertas.** `draft_sales` guarda cada venda aberta (nome, situação `open`/`completed`/`discarded`, operador, revisão e a venda gerada) e `draft_sale_items` os itens, com `scale_capture_id` único por ciclo de pesagem. `draft_sale_events` registra transferências, descartes e correções. `shifts.active_draft_id` aponta a venda que a balança está pesando, e `sales.draft_sale_id` liga cada venda cobrada à venda aberta de origem, com índice único (uma venda aberta vira no máximo uma venda). As alterações do banco são **migrações numeradas** (`PRAGMA user_version`, hoje 3), aplicadas sozinhas na primeira execução sem apagar dados.

### Segurança e restrições

- Servidor escuta somente `127.0.0.1` (não exposto para Internet/rede).
- Operações de escrita exigem token local por sessão. O operador é **identificado pelo nome, sem senha**: qualquer funcionário pode cancelar vendas e digitar peso/valor, e o sistema registra quem fez e o motivo. Não há níveis de permissão nem política de acesso.
- Um caixa por vez; uma estação local; sem suporte a múltiplas máquinas simultâneas.
- As vendas abertas ficam no SQLite e voltam como estavam ao reiniciar (com a mesma venda na balança). Uma pesagem que falhou e ainda não foi refeita fica só na memória do servidor: se o programa for fechado nesse momento, pese o copo de novo.
- Não utilizar o modo demonstração para registrar vendas reais.
- O banco contém informações comerciais: deve-se providenciar backups periódicos e política de proteção de dados antes da implantação.

## 7. Próximas fases recomendadas

**P0 — Homologação de hardware**
- Inspecionar as portas da unidade; validar versão do firmware e opções de conexão.
- Obter/acertar cabo e conversor com Toledo; testar Prt5 no Windows com logs brutos de bytes.
- Executar bateria de testes: zero, estabilidade, perda de conexão, reconexão, remoção do prato, pesagens seguidas, peso negativo e sobrecarga.
- Definir se preço é calculado apenas no sistema ou também enviado à balança, e regras de tara/recipiente.

**P0 — Operação e conformidade**
- Validar com a equipe o fluxo de venda, cancelamento e fechamento já implementados; definir estorno financeiro ao cliente e forma de cobrança.
- Confirmar regras metrológicas com Toledo/IPEM e documentar ensaios de homologação.
- Integrar documento fiscal conforme regime tributário e legislação aplicável antes de comercializar.
- Senha/permissões por função (se a loja precisar), backup/restore, testes de contingência e atualização de versão.

**P1 — Evolução**
- Produto por categoria, estoque por receita de sorvete, gastos/insumos, fornecedores.
- Relatório por produto e exportação (planilha/PDF).
- Impressão de comprovante não fiscal e integração de maquininha, se necessário.
- Pacote instalador Windows (Electron opcional), inicialização automática e suporte remoto.

## 8. Testes executados

```bash
npm test
```

São 49 testes, sem dependências externas (`node --test`):

- `tests/protocol.test.js`: quadros Prt5 (estável, instável, negativo, sobrecarga), quadros fragmentados e arredondamento em reais.
- `tests/scale.test.js`: **porta serial simulada** que responde ao `ENQ` como a balança. O peso estável entra na venda **automaticamente e uma única vez**; o mesmo copo no prato não duplica; só relança depois de voltar a zero; leituras instáveis, negativas, de sobrecarga ou oscilando nunca viram item; quadros quebrados em vários pedaços funcionam; com o caixa fechado ou o lançamento automático desligado o peso espera na balança; porta desconectada fica offline e o lançamento manual continua funcionando.
- `tests/store.test.js`: venda com o mesmo identificador gravada uma vez só; as quatro formas de pagamento somam certo e só dinheiro entra no caixa; troco calculado e gravado, valor recebido menor que o total rejeitado sem gravar a venda; fechamento com diferença para mais e para menos, bloqueado com venda em aberto e sem novas vendas depois; sangria acima do caixa rejeitada; operador obrigatório e registrado; peso/valor digitados (válidos e inválidos); cancelamento devolve estoque e sai dos totais, exige motivo e não repete; cancelar e corrigir em venda própria; relatórios de dia, semana e mês pelo calendário local; atualização de um banco da versão 0.1 sem perder vendas.
- `tests/http.test.js`: servidor real em porta aleatória. Token e host obrigatórios; fluxo completo (operador, abertura, 840 g → 0 → 420 g automáticos, produto, peso digitado, dinheiro com troco e Pix, fechamento sem diferença); **duplo clique em Cobrar** (mesmo pedido duas vezes ao mesmo tempo, e dois pedidos diferentes para a mesma venda) gera exatamente uma venda; histórico, cancelamento e correção pela API.
- `tests/open-sales.test.js` (vendas simultâneas, casos T01 a T18 do plano): cada venda com seus itens e total (T01); nova venda selecionada com nome automático, renomear e nomes repetidos (T02); a balança só lança na venda selecionada (T03); três clientes pesados alternadamente e cobrados em outra ordem sem misturar nada (T04); pesagem manual só na venda da balança, vendas cobradas ou descartadas não aceitam itens (T05); troca bloqueada com peso no prato e liberada no zero (T06); um ciclo de pesagem vira um item só, inclusive depois de reconectar a porta serial com o copo no prato (T07); transferência registrada nas duas vendas (T08); cobrar uma venda não altera as outras nem põe outro cliente na balança (T09); vendas abertas voltam depois de reiniciar (T10); descartar uma venda não altera as outras (T11); fechamento bloqueado com vendas pendentes e abas vazias fechadas junto (T12); cobrança duplicada, inclusive pelo índice único do banco, e total conferido que mudou (T13); reserva de estoque entre vendas (T14); falha no meio da cobrança não grava nada (T15); correção em venda separada (T16); balança desconectada com digitação e troca de venda funcionando (T17); atualização de um banco da versão anterior e pesagem que falhou ao gravar, com "Tentar de novo" e "Descartar" (T18).

**Nenhum teste de comunicação com a balança física foi realizado**; as fotos e o vídeo não demonstram a existência de cabo de dados ou qual interface está instalada.

## 9. Demonstração online (Netlify)

O Netlify hospeda só arquivos estáticos, então ele não roda o servidor local, o SQLite em arquivo nem a porta serial. A pasta `demo/` gera uma **versão de demonstração que roda inteira no navegador**, para apresentar o sistema a clientes:

- usa os mesmos `src/server.js`, `src/db.js`, `src/scale.js` e `public/` da loja; o SQLite roda no navegador com [sql.js](https://github.com/sql-js/sql.js) (WebAssembly);
- vem com seis semanas de vendas de exemplo e o caixa do dia aberto, com duas vendas em atendimento ("Família Oliveira" e "Mesa da varanda") e uma terceira vazia na balança; as datas acompanham o dia de quem abre;
- balança simulada com botões de peso na frente de caixa; conexão serial desativada;
- os dados ficam só no navegador de quem usa (`localStorage`), e o botão **Restaurar exemplo** volta ao início.

```bash
npm install
npm run build:demo
```

O resultado fica em `dist/` (cabeçalhos de segurança em `demo/_headers`). Para conferir antes de publicar, rode `node demo/serve.js` e abra http://127.0.0.1:4173. Para publicar, ligue o repositório no Netlify (o `netlify.toml` já define o build) ou envie a pasta pronta com `netlify deploy --dir dist --no-build --prod`.

A demonstração **não substitui** a instalação da loja: não lê a balança Toledo e não guarda dados em servidor.
