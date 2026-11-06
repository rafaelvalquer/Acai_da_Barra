# Luminor PDV — Açaí da Barra (v0.2)

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
- Dados persistentes em SQLite local, numa **pasta permanente fora do programa** (`C:\ProgramData\LuminorPDV`): atualizar ou reinstalar nunca apaga vendas. Registros de vendas guardam preços e pesos utilizados no momento da venda. O banco da versão 0.1 (`data\luminor-pdv.sqlite` dentro da pasta do programa) é **copiado** uma vez na primeira execução, sem alterar o original; bancos antigos são atualizados automaticamente, sem perder vendas (vendas antigas aparecem sem operador, "—").

**Administração, backup e banco de dados** (aba **Configurações**, com senha; detalhes nas seções 4 a 6)
- Área administrativa protegida por usuário e senha, separada do dia a dia do caixa: os funcionários continuam vendendo sem senha. No primeiro acesso de uma instalação nova entra-se com `admin`/`admin` e o sistema exige na hora uma senha definitiva.
- **Backup automático diário** (02:00, ou na próxima inicialização se o computador estava desligado), backup a cada fechamento de caixa e backup manual com um toque. Arquivos `.luminorbackup` **criptografados** (AES-256-GCM), guardados 7 diários, 4 semanais e 3 mensais, com cópia opcional para um pendrive ou outra pasta.
- **Restauração guiada** (arquivo → chave → conferência → senha): confere o arquivo antes, mostra o que será restaurado, faz um backup de segurança do banco atual e desfaz tudo se algo falhar.
- **Banco na nuvem (Supabase/PostgreSQL) opcional**, migrado pela tela: testar conexão, preparar, migrar com conferência tabela por tabela e ativar. Se a nuvem cair, a administração continua acessível e dá para voltar ao banco local.
- Segurança (troca de usuário e senha, acessos recentes, código de recuperação de emergência), manutenção (versão, serviço, balança, banco, último backup, espaço em disco, registros e diagnóstico sem senhas) e configurações de backup.
- **Instalador Windows** (`instalador\instalar.bat`): o PDV inicia sozinho com o computador, reinicia se cair, ganha atalho na área de trabalho e a pasta de dados fica protegida. Atualizar faz um backup antes.

**Fora do escopo do MVP:** NFC-e, SAT/CF-e, integração fiscal, TEF, conciliação automática com adquirente, pagamento dividido entre formas de pagamento, QR Code/comanda impressa, vendas abertas compartilhadas entre vários computadores, senha ou níveis de permissão para funcionários (o operador é identificado só pelo nome; só a área administrativa tem senha), impressora fiscal, estoque por ingredientes/receitas, integração com sistema da franquia e sincronização entre o banco local e a nuvem (o Supabase **substitui** o banco local quando ativado; não há uso dos dois ao mesmo tempo).

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

## 3. Instalação e execução em Windows

Requisito: **Node.js 22.16 LTS ou superior**, pelo instalador oficial de https://nodejs.org (para todos os usuários). Foi testado com Node 22.17.

### 3.1 Instalar no computador da loja (recomendado)

1. Descompacte o pacote do Luminor PDV em qualquer pasta (por exemplo, Downloads).
2. Dê dois cliques em **`instalador\instalar.bat`** e aceite a pergunta do Windows (precisa de um usuário administrador do Windows e de internet na primeira vez, para baixar os componentes).
3. Ao terminar, abra o caixa pelo atalho **Luminor PDV** na área de trabalho (ou no menu Iniciar). Ele abre uma janela própria do Edge em `http://127.0.0.1:3187`.
4. Em **Configurações › Administração do sistema**, entre com `admin`/`admin`, defina a senha definitiva, gere o **código de recuperação** (Segurança) e anote a **chave de recuperação dos backups** (Backup e restauração). Guarde os dois fora do computador.

O instalador:
- copia o programa para `C:\Program Files\LuminorPDV` (opção `-Destino` para outra pasta), preparando a versão nova numa pasta à parte antes de trocar;
- cria a tarefa do Windows **"Luminor PDV"**, que inicia o PDV junto com o computador (conta SYSTEM, mesmo sem ninguém conectado, prioridade normal). Quem roda é `src\launcher.js`, que inicia `src\main.js` e o **reinicia se ele cair** (registro em `logs\inicializador.log`);
- protege `C:\ProgramData\LuminorPDV` para que só o Windows (SYSTEM) e os administradores abram os arquivos; os funcionários usam o PDV pelo navegador;
- se encontrar o banco da versão 0.1 dentro do pacote (`data\luminor-pdv.sqlite`), ele é copiado na primeira inicialização, sem alterar o original;
- grava um registro da instalação em `C:\ProgramData\LuminorPDV\logs\instalacao-*.log`.

O servidor escuta só em `127.0.0.1`: nada fica exposto na rede e não é preciso liberar firewall.

### 3.2 Atualizar, reparar e remover

- **Atualizar:** descompacte a versão nova e rode o `instalador\instalar.bat` dela. O instalador prepara a nova versão, para o PDV de forma limpa (o banco é fechado), faz um **backup "antes de atualizar"** (`backups\seguranca`), troca o programa e inicia de novo. A versão anterior fica em `C:\Program Files\LuminorPDV.anterior`. Se o backup falhar, nada é trocado e a versão atual volta a rodar. Atualizar nunca reativa a senha `admin`.
- **Reparar:** rodar o `instalar.bat` da própria pasta instalada recria a tarefa, as permissões e os atalhos sem trocar o programa.
- **Remover:** `instalador\desinstalar.bat` remove a tarefa, os atalhos e a pasta do programa. **Os dados ficam** em `C:\ProgramData\LuminorPDV`; uma nova instalação os encontra.
- Backup avulso pelo terminal (como administrador): `npm run backup` (ou `npm run backup -- --tipo atualizacao`).

### 3.3 Executar sem instalar (demonstração ou desenvolvimento)

Dê dois cliques em `iniciar-windows.bat` (confere o Node.js, baixa os componentes na primeira vez e abre o caixa; mantenha a janela aberta) ou rode no terminal:

```bat
npm ci
npm start
```

e abra `http://127.0.0.1:3187`. Se o PDV instalado já estiver rodando, o `iniciar-windows.bat` só abre o caixa.

### 3.4 Pasta de dados e configuração

| Pasta (em `C:\ProgramData\LuminorPDV`) | Conteúdo |
| --- | --- |
| `data\` | banco local `luminor-pdv.sqlite` (vendas, produtos, caixa) |
| `backups\automaticos`, `manuais`, `seguranca` | backups `.luminorbackup` e `estado.json` (histórico) |
| `logs\` | `pdv-AAAA-MM-DD.log` (30 dias), `inicializador.log`, `auditoria.log`, instalações |
| `config\` | `luminor-pdv.env` (configuração), `admin.sqlite` (contas e auditoria da administração), `cofre.dat` (segredos protegidos pelo Windows), `hardware.json` (porta da balança) |

`config\luminor-pdv.env` é criado na primeira execução, com comentários. Chaves aceitas (variáveis de ambiente têm prioridade): `PORT` (3187), `PDV_BACKUP_ENABLED`, `PDV_BACKUP_TIME` (02:00), `PDV_BACKUP_RETENTION_DAYS` (7), `LUMINOR_TIMEZONE` (`America/Sao_Paulo`), `PDV_DATABASE_PROVIDER`/`DATABASE_URL`/`PDV_DATABASE_CA_FILE` (só se o banco não foi escolhido pela tela de administração), `PDV_SQLITE_PATH`, `PDV_LEGACY_SQLITE` e `PDV_VAULT` (`dpapi`, padrão no Windows, ou `arquivo`). `PDV_HOME` troca a pasta de dados inteira (usado em testes); `LUMINOR_DATA_DIR`, da versão 0.1, ainda funciona como pasta de dados.

### 3.5 Roteiro de demonstração

1. Na aba **Funcionários**, cadastrar quem vai operar o caixa.
2. Na aba **Movimentação de caixa**, escolher o operador e abrir o turno.
3. Na aba **Balança Toledo**, ativar o modo demonstração.
4. Simular 840 g; retornar a 0 g; simular 420 g; verificar que foram lançados **dois itens**.
5. Na **Frente de caixa**, ajustar o preço por kg, incluir produtos unitários (se cadastrados) ou digitar um peso/valor, escolher a forma de pagamento e cobrar a venda.
   Para testar vendas simultâneas: com o prato em 0 g, toque em **Nova venda**, simule outro peso, volte à primeira aba e cobre as duas em qualquer ordem.
6. Conferir o **Histórico de vendas** e os **Relatórios** e fechar o caixa.

**Preço de demonstração:** R$ 64,90/kg, inspirado na fotografia enviada. **É preciso confirmar o preço praticado** antes da primeira operação.

## 4. Administração do sistema

Fica em **Configurações** (no celular, "Ajustes"), no cartão **Administração do sistema**. O dia a dia do caixa (vender, pesar, abrir e fechar o caixa) **não pede senha**; só esta área.

- **Primeiro acesso:** `admin`/`admin` funciona **apenas numa instalação nova**, e o sistema exige na hora uma senha definitiva (12 caracteres ou mais, sem senhas óbvias; a tela mostra as regras). Depois disso a senha padrão nunca volta: nem restaurando um backup, nem migrando para a nuvem, nem atualizando o programa.
- **Painel:** Banco de dados, Backup e restauração, Segurança, Manutenção, Configurações e Sobre. Alertas (backup que falhou ou sem backup há 48 horas, cópia para o pendrive que falhou, chave dos backups não anotada, código de recuperação não gerado, banco na nuvem fora do ar) aparecem no topo do painel e como um ponto no botão Configurações.
- **Segurança:** trocar usuário e senha (confirmando a senha atual), sair, ver os acessos recentes e gerar o **código de recuperação de emergência** (16 caracteres, vale uma vez). Senhas guardadas com Argon2id; 5 tentativas erradas bloqueiam por 5 minutos (o bloqueio continua depois de reiniciar); a sessão termina com 15 minutos sem uso ou 8 horas depois de entrar.
- **Ações críticas** (preparar, migrar ou ativar a nuvem, voltar ao banco local, restaurar backup, ver a chave dos backups, gerar código) pedem a senha de novo.
- **Esqueci a senha:** "Esqueci a senha" na tela de entrada, com o código de recuperação. Sem o código, um administrador do Windows roda na pasta do programa `npm run admin:redefinir -- --confirmar`, que mostra uma senha temporária (a troca é exigida no próximo acesso).
- **Manutenção:** versão, serviço (Node, memória, se está sob o inicializador), balança, banco ativo, último backup, espaço em disco, registros recentes e **exportar diagnóstico** (arquivo JSON sem senhas, chaves ou vendas, para o suporte).
- As contas, sessões e a auditoria da administração ficam em `config\admin.sqlite`, **separado do banco das vendas**: a administração funciona mesmo com a nuvem fora do ar, e restaurar um backup nunca troca o usuário ou a senha de administrador.

## 5. Backup e restauração

- **Automático:** todo dia às 02:00 (horário, dias guardados e liga/desliga em Backup e restauração). Se o computador estava desligado nesse horário, o backup é feito ao ligar. Também há um backup a cada **fechamento de caixa** (só se algo mudou) e o botão **Fazer backup agora**.
- **Retenção:** 7 diários, 4 semanais e 3 mensais dos automáticos; os 20 manuais mais recentes; os 10 de segurança mais recentes.
- **Segunda cópia:** informe uma pasta (por exemplo, um pendrive) em Backup e restauração. Se ela não estiver disponível, o backup local é feito do mesmo jeito e aparece um aviso.
- **Formato `.luminorbackup`:** banco comprimido e **criptografado com AES-256-GCM**, com resumo (vendas, produtos, data) e verificação de integridade (SHA-256). A chave fica neste computador; a **chave de recuperação** (mostrada na tela, com senha) é o que abre os backups em outro computador. Anote-a: sem ela, um backup levado para um computador novo não abre.
- **Restaurar:** Backup e restauração › escolher o arquivo (do computador ou pendrive) › o sistema confere o arquivo (e pede a chave de recuperação se ele veio de outro computador) › mostra data, versão e quantidades › confirmar com a senha. É preciso **caixa fechado e nada na balança**. Antes de trocar, um **backup de segurança** do banco atual é gravado; se qualquer etapa falhar, o banco anterior volta sozinho (inclusive se o computador desligar no meio). Nenhum comando SQL do arquivo é executado: só um banco do Luminor PDV com a estrutura esperada é aceito.
- **Com o Supabase ativo**, o backup é uma exportação dos dados do PostgreSQL no mesmo formato, e pode ser restaurado num banco local (por exemplo, num computador novo).
- Toda restauração (aceita, recusada ou com falha) fica registrada na auditoria.

## 6. Banco de dados na nuvem (Supabase), opcional

O padrão é o banco local (SQLite), que não depende de internet. Para usar o Supabase:

1. No Supabase, crie o projeto na região **South America (São Paulo)** e copie o endereço em **Connect › Session pooler** (funciona em internet só IPv4, como a da maioria das lojas). A região pesa muito: cada consulta atravessa a internet, e daqui ao Supabase em São Paulo a ida e volta medida foi de ~13 ms, contra 200 a 470 ms até um projeto nos EUA (cobrar uma venda: ~0,45 s contra ~5 s). A região de um projeto não muda depois de criado.
2. Em **Banco de dados**, cole o endereço, digite a senha do banco e toque em **Testar conexão**. O endereço e a senha ficam no cofre do Windows (`config\cofre.dat`, protegido por DPAPI) e nunca voltam para o navegador.
3. **Preparar** cria as tabelas (o banco precisa estar vazio; um banco com outras tabelas é recusado).
4. **Migrar** copia os dados locais e confere tabela por tabela e os totais. O banco local não é alterado.
5. **Ativar** passa o PDV a usar a nuvem. Se houver vendas novas no banco local depois da migração, a ativação é recusada (migre de novo).

Para a internet pesar o mínimo: a tela do caixa só relê o banco depois de alguma alteração (enquanto nada muda, a atualização automática não faz consulta), pede a próxima atualização só depois que a anterior respondeu, as leituras independentes saem juntas e as conexões ficam abertas (com limite de 30 s por consulta, para o caixa nunca ficar travado).

Se a nuvem ficar fora do ar, o caixa mostra o aviso, a administração continua acessível e **Voltar para o banco local** oferece "copiar os dados da nuvem" (quando ela responde) ou "manter o banco local como estava". Sem internet, nada é perdido: o banco local continua no computador. Pelo terminal também há `npm run migrar:postgres` (ensaio num PostgreSQL temporário) e `npm run migrar:postgres -- --confirmar`.

## 7. Como habilitar a balança física

A comunicação serial real depende de um acessório/interface compatível instalado na Prix 3 Fit e configurado para o computador. Pela documentação, a linha pode oferecer RS-232C, USB ou Bluetooth; depende de modelo/firmware e acessórios.

1. Confirmar fisicamente a interface existente e o cabo/conversor adequado, com técnico ou suporte Toledo.
2. Instalar o driver do conversor serial USB, quando aplicável, e identificar a porta COM no Windows.
3. A biblioteca serial (`serialport`, dependência opcional) já é baixada pelo instalador ou pelo `npm ci`. Se ela não puder ser instalada, o modo demonstração continua funcionando. A porta escolhida fica gravada em `config\hardware.json` e volta a conectar sozinha ao iniciar.
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

## 8. Importante: conformidade metrológica e fiscal

O manual Toledo inclui orientação específica para **balanças em automação de pontos de venda**, com necessidade de apreciação/autorização prévia pelo órgão metrológico conforme o enquadramento aplicável. **Verificar com Toledo e IPEM/Inmetro antes da implantação real**, especialmente a integração da indicação do peso e a comercialização por peso. A homologação e o uso legal não foram avaliados nem concluídos neste MVP.

O sistema **não emite nota fiscal ou cupom fiscal**, nem substitui PDV fiscal homologado. Exige desenvolvimento, validação tributária e adequação local para uso real em vendas.

## 9. Arquitetura

```text
Tarefa do Windows "Luminor PDV" (SYSTEM, ao ligar)
  └─ src/launcher.js ── reinicia se cair ──┐
                                          ▼
Prix 3 Fit/2 ──(Prt5 por COM)──┐   src/main.js ─ Node.js HTTP (127.0.0.1:3187)
Simulador de peso ─────────────┴─▶   ├─ API do caixa /api/*  e  administração /api/admin/*
                                     ├─ State machine anti-duplicidade da balança
                                     ├─ PdvStore ─ adaptador SQLite (local) ou PostgreSQL (Supabase)
                                     ├─ Backups criptografados, agendador e restauração com rollback
                                     └─ HTML/CSS/JS sem framework (public/)
C:\ProgramData\LuminorPDV ─ data · backups · logs · config (admin.sqlite, cofre.dat)
```

- `src/main.js`: inicialização (pasta de dados, cofre, administração, banco, balança, backups e servidor). `src/launcher.js`: supervisor usado pela tarefa do Windows.
- `src/config/`: leitura da configuração e da pasta permanente (`index.js`), cofre de segredos com DPAPI (`SecretVault.js`) e preferências da administração.
- `src/store.js`, `src/services/` e `src/database/repositories/`: regras de venda, caixa, estoque e relatórios, iguais para os dois bancos. `src/database/adapters/` traz os adaptadores SQLite (`node:sqlite`) e PostgreSQL (`pg`), `src/database/migrations/` as migrações numeradas de cada um, e `src/database/DatabaseManager.js` e `DatabaseMigrationService.js` a escolha do banco e a migração para a nuvem.
- `src/auth/`: contas, senhas (Argon2id via `hash-wasm`), sessões e o primeiro acesso da administração. `src/admin/`: rotas `/api/admin/*` e o painel (visão geral, diagnóstico).
- `src/backup/`: formato `.luminorbackup`, chaves, criação, retenção, agendador e restauração.
- `src/protocol.js` e `src/scale.js`: protocolo Prt5, driver serial opcional, simulador, anti-duplicidade e estabilidade. `src/hardware.js`: porta da balança gravada.
- `src/server.js`: servidor HTTP local e API do caixa. `public/`: interface do caixa (`app.js`) e da administração (`admin.js`, `admin.css`).
- `instalador/`: instalar, atualizar, remover e abrir o caixa (`*.ps1`, com atalhos `*.bat`). `iniciar-windows.bat`: execução sem instalar.
- `tests/`: testes automatizados (seção 11).

### API local

Todas as rotas `POST` exigem o cabeçalho `X-Luminor-Token` obtido em `GET /api/session`. `GET /api/health` responde se o PDV está no ar (versão e banco), sem dados.

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

**Administração** (`/api/admin/*`). A sessão é um cookie `luminor_admin` HttpOnly, SameSite=Strict, restrito a `/api/admin`. Além do token, os `POST` precisam vir da própria página (Origin/Referer); as rotas marcadas com † pedem `{password}` (a senha atual) de novo.

| Área | Rotas |
| --- | --- |
| Acesso | `GET session` (situação: inicial, recuperação, sessão), `POST login` `{username, password}`, `recover` `{username, code}`, `logout`, `change-password` `{current, next}`, `change-username` `{username, password}`, `recovery-code` † |
| Painel e manutenção | `GET overview`, `GET diagnostics`, `POST diagnostics/export` (arquivo JSON), `GET access-log`, `GET audit` |
| Banco de dados | `GET database`, `POST database/integrity`, `database/test` `{url, password, ca?}`, `database/prepare` †, `database/migrate` †, `database/activate` †, `database/use-local` † `{mode: copiar\|manter}` |
| Backup | `GET backup` (histórico, agenda, alertas), `POST backup/export` (backup agora), `backup/download` `{name}`, `backup/settings` `{enabled, time, retentionDays, extraFolder}`, `backup/recovery-key` †, `backup/recovery-key/confirm` |
| Restauração | `POST backup/restore/upload` (bytes do arquivo), `backup/restore/validate` `{uploadId, recoveryKey?}`, `backup/restore/cancel` `{uploadId}`, `backup/restore` † `{uploadId}` |

Sem sessão a resposta é 401; com a senha inicial ainda não trocada, 403 em tudo menos a troca de senha; 5 erros de senha, 429 por 5 minutos.

O PDV utiliza `node:sqlite`, presente no Node.js 22, que ainda emite um **aviso de API experimental** nessa versão (o aviso não aparece na tela do instalador). O banco local roda em modo WAL e os backups usam a cópia nativa do SQLite.

**Banco de dados das vendas abertas.** `draft_sales` guarda cada venda aberta (nome, situação `open`/`completed`/`discarded`, operador, revisão e a venda gerada) e `draft_sale_items` os itens, com `scale_capture_id` único por ciclo de pesagem. `draft_sale_events` registra transferências, descartes e correções. `shifts.active_draft_id` aponta a venda que a balança está pesando, e `sales.draft_sale_id` liga cada venda cobrada à venda aberta de origem, com índice único (uma venda aberta vira no máximo uma venda). As alterações do banco são **migrações numeradas** (versão do esquema hoje 4, a mesma no SQLite e no PostgreSQL), aplicadas sozinhas na primeira execução sem apagar dados.

### Segurança e restrições

- Servidor escuta somente `127.0.0.1` (não exposto para Internet/rede). Respostas com CSP restritiva (`script-src 'self'`), sem scripts de terceiros.
- Operações de escrita exigem token local por sessão. O operador é **identificado pelo nome, sem senha**: qualquer funcionário pode cancelar vendas e digitar peso/valor, e o sistema registra quem fez e o motivo. Só a área administrativa (seção 4) tem senha.
- Segredos (chave dos backups, endereço e senha do banco na nuvem) ficam em `config\cofre.dat`, protegidos pelo Windows (DPAPI) e pelas permissões da pasta; nunca vão para o navegador nem para o diagnóstico. Senhas de banco são mascaradas nos registros.
- Um caixa por vez; uma estação local; sem suporte a múltiplas máquinas simultâneas.
- As vendas abertas ficam no banco e voltam como estavam ao reiniciar (com a mesma venda na balança). Uma pesagem que falhou e ainda não foi refeita fica só na memória do servidor: se o programa for fechado nesse momento, pese o copo de novo.
- Não utilizar o modo demonstração para registrar vendas reais.
- O banco contém informações comerciais: mantenha o backup automático ligado, a segunda cópia num pendrive e a chave de recuperação anotada fora do computador.

## 10. Próximas fases recomendadas

**P0 — Homologação de hardware**
- Inspecionar as portas da unidade; validar versão do firmware e opções de conexão.
- Obter/acertar cabo e conversor com Toledo; testar Prt5 no Windows com logs brutos de bytes.
- Executar bateria de testes: zero, estabilidade, perda de conexão, reconexão, remoção do prato, pesagens seguidas, peso negativo e sobrecarga.
- Definir se preço é calculado apenas no sistema ou também enviado à balança, e regras de tara/recipiente.

**P0 — Operação e conformidade**
- Validar com a equipe o fluxo de venda, cancelamento e fechamento já implementados; definir estorno financeiro ao cliente e forma de cobrança.
- Confirmar regras metrológicas com Toledo/IPEM e documentar ensaios de homologação.
- Integrar documento fiscal conforme regime tributário e legislação aplicável antes de comercializar.
- Senha/permissões por função para os funcionários (se a loja precisar).
- Ensaiar na loja: instalação, atualização, restauração de um backup num computador novo (com a chave de recuperação) e queda de energia.

**P1 — Evolução**
- Produto por categoria, estoque por receita de sorvete, gastos/insumos, fornecedores.
- Relatório por produto e exportação (planilha/PDF).
- Impressão de comprovante não fiscal e integração de maquininha, se necessário.
- Instalador assinado (MSI) com o Node.js embutido e suporte remoto.

## 11. Testes executados

```bash
npm test
npm run test:postgres
```

`npm test` roda 94 testes (`node --test`), sem internet e sem tocar na pasta de dados real: cada teste usa uma pasta temporária. `npm run test:postgres` roda os testes das regras de venda (vendas, vendas abertas, balança, API do caixa) num **PostgreSQL de verdade dentro do processo** (PGlite), para garantir que o Supabase se comporta igual ao SQLite; os testes que dependem de arquivos locais (backup, administração) ficam de fora nesse modo.

- `tests/protocol.test.js`: quadros Prt5 (estável, instável, negativo, sobrecarga), quadros fragmentados e arredondamento em reais.
- `tests/scale.test.js`: **porta serial simulada** que responde ao `ENQ` como a balança. O peso estável entra na venda **automaticamente e uma única vez**; o mesmo copo no prato não duplica; só relança depois de voltar a zero; leituras instáveis, negativas, de sobrecarga ou oscilando nunca viram item; quadros quebrados em vários pedaços funcionam; com o caixa fechado ou o lançamento automático desligado o peso espera na balança; porta desconectada fica offline e o lançamento manual continua funcionando.
- `tests/store.test.js`: venda com o mesmo identificador gravada uma vez só; as quatro formas de pagamento somam certo e só dinheiro entra no caixa; troco calculado e gravado, valor recebido menor que o total rejeitado sem gravar a venda; fechamento com diferença para mais e para menos, bloqueado com venda em aberto e sem novas vendas depois; sangria acima do caixa rejeitada; operador obrigatório e registrado; peso/valor digitados (válidos e inválidos); cancelamento devolve estoque e sai dos totais, exige motivo e não repete; cancelar e corrigir em venda própria; relatórios de dia, semana e mês pelo calendário local; atualização de um banco da versão 0.1 sem perder vendas.
- `tests/http.test.js`: servidor real em porta aleatória. Token e host obrigatórios; fluxo completo (operador, abertura, 840 g → 0 → 420 g automáticos, produto, peso digitado, dinheiro com troco e Pix, fechamento sem diferença); **duplo clique em Cobrar** (mesmo pedido duas vezes ao mesmo tempo, e dois pedidos diferentes para a mesma venda) gera exatamente uma venda; histórico, cancelamento e correção pela API.
- `tests/open-sales.test.js` (vendas simultâneas, casos T01 a T18 do plano): cada venda com seus itens e total (T01); nova venda selecionada com nome automático, renomear e nomes repetidos (T02); a balança só lança na venda selecionada (T03); três clientes pesados alternadamente e cobrados em outra ordem sem misturar nada (T04); pesagem manual só na venda da balança, vendas cobradas ou descartadas não aceitam itens (T05); troca bloqueada com peso no prato e liberada no zero (T06); um ciclo de pesagem vira um item só, inclusive depois de reconectar a porta serial com o copo no prato (T07); transferência registrada nas duas vendas (T08); cobrar uma venda não altera as outras nem põe outro cliente na balança (T09); vendas abertas voltam depois de reiniciar (T10); descartar uma venda não altera as outras (T11); fechamento bloqueado com vendas pendentes e abas vazias fechadas junto (T12); cobrança duplicada, inclusive pelo índice único do banco, e total conferido que mudou (T13); reserva de estoque entre vendas (T14); falha no meio da cobrança não grava nada (T15); correção em venda separada (T16); balança desconectada com digitação e troca de venda funcionando (T17); atualização de um banco da versão anterior e pesagem que falhou ao gravar, com "Tentar de novo" e "Descartar" (T18).
- `tests/admin.test.js` (administração): primeiro acesso com `admin`/`admin` só numa instalação nova e troca obrigatória; troca de usuário e senha com confirmação; sair e registro de acessos; bloqueio depois de 5 erros (que continua após reiniciar, também para usuário inexistente) e confirmações erradas contando como tentativas; sessão que expira sem uso e atributos do cookie; operador sem sessão recusado em todas as rotas; atualização do programa mantendo a senha; `admin.sqlite` perdido recriado só com o código de recuperação; senha temporária do `admin:redefinir`; restaurar um backup não muda a senha; instalação nova restaurando um backup mantém o próprio administrador.
- `tests/backup.test.js` (backup e restauração, casos D01 a D16): backup com o caixa aberto consistente e sem parar as vendas (D01); vendas abertas voltam iguais depois de restaurar (D02); instalação vazia só restaura com a chave de recuperação e a senha (D03); arquivo corrompido, truncado, de versão mais nova ou com estrutura estranha recusado sem mudar nada (D04, D05); restauração recusada com caixa aberto ou peso na balança (D06); queda de energia durante o backup ou no meio da restauração desfeita no próximo início (D07, D08); falha no meio da restauração devolve o banco anterior (D08); reinício e atualização mantêm tudo, e o banco da pasta antiga do programa é copiado uma vez, nunca alterado (D09, D10); backup perdido com o computador desligado feito ao ligar, uma vez só (D11); disco cheio com aviso e vendas seguindo (D12); rotas protegidas: sem sessão, sessão de troca de senha, sem token, outro site e nomes de arquivo maliciosos (D13); cópia para pendrive e aviso quando ele falta (D14); ida e volta comparando todas as tabelas (D16); retenção 7/4/3, agenda no horário de São Paulo e arquivo autenticado (chave errada e byte alterado recusados).
- `tests/admin-database.test.js` (nuvem, com um PostgreSQL simulado): migrar, ativar, vender na nuvem, backup da nuvem restaurado num banco local e volta ao local copiando os dados; nuvem fora do ar com a administração acessível e volta ao local mantendo o banco; endereço inválido; migração interrompida; vendas locais depois da migração bloqueando a ativação; banco com outras tabelas recusado.
- `tests/launcher.test.js` (inicializador): reinicia o PDV depois de falhas, encerra de forma limpa quando pedido, descarta um pedido de parada antigo e espera mais quando a configuração é inválida.
- `tests/state-cache.test.js` (tela do caixa): sem nada novo no banco a atualização não faz consulta; qualquer gravação (venda, item, funcionário, produto, ajuste, alteração direta no banco) aparece na atualização seguinte; operação recusada não deixa dado velho; o peso da balança é sempre o do momento.

O instalador (`instalador\*.ps1`) não tem teste automatizado: os scripts foram conferidos pelo analisador do PowerShell e as partes sem efeito no sistema (cópia, carregamento da versão nova, backup antes de atualizar, inicializador com parada limpa e reinício depois de queda) foram executadas numa pasta temporária. Criar a tarefa do Windows e ajustar as permissões da pasta deve ser ensaiado no computador da loja.

**Nenhum teste de comunicação com a balança física foi realizado**; as fotos e o vídeo não demonstram a existência de cabo de dados ou qual interface está instalada.

## 12. Demonstração online (Netlify)

O Netlify hospeda só arquivos estáticos, então ele não roda o servidor local, o SQLite em arquivo nem a porta serial. A pasta `demo/` gera uma **versão de demonstração que roda inteira no navegador**, para apresentar o sistema a clientes:

- usa os mesmos `src/server.js`, `src/store.js` (com serviços e repositórios), `src/scale.js` e `public/` da loja; o SQLite roda no navegador com [sql.js](https://github.com/sql-js/sql.js) (WebAssembly);
- a **administração do sistema não faz parte da demonstração** (backups, senhas e banco na nuvem só existem na instalação da loja): o cartão em Configurações explica isso;
- vem com seis semanas de vendas de exemplo e o caixa do dia aberto, com duas vendas em atendimento ("Família Oliveira" e "Mesa da varanda") e uma terceira vazia na balança; as datas acompanham o dia de quem abre;
- balança simulada com botões de peso na frente de caixa; conexão serial desativada;
- os dados ficam só no navegador de quem usa (`localStorage`), e o botão **Restaurar exemplo** volta ao início.

```bash
npm install
npm run build:demo
```

O resultado fica em `dist/` (cabeçalhos de segurança em `demo/_headers`). Para conferir antes de publicar, rode `node demo/serve.js` e abra http://127.0.0.1:4173. Para publicar, ligue o repositório no Netlify (o `netlify.toml` já define o build) ou envie a pasta pronta com `netlify deploy --dir dist --no-build --prod`.

A demonstração **não substitui** a instalação da loja: não lê a balança Toledo e não guarda dados em servidor.
