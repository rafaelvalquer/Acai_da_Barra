# Homologação: perfis de usuário e fechamento de caixa cego

Versão do banco comercial: **6** (`employee_permissions`). `config\admin.sqlite`: **2** (`operator_accounts`, `pos_sessions`).
Resumo do que mudou e de como usar: README, seções 3.2 (atualizar e voltar), 4.1 (PIN e permissões), 4.2 (caixa cego) e 9 (rotas).

## 1. Relatório de execução (12/11/2026, Windows 11, Node 22)

| Comando | Resultado |
| --- | --- |
| `npm test` | 163 testes, 163 passaram, 0 falhas |
| `npm run test:postgres` (PGlite) | 163 testes: 111 passaram, 0 falhas, 52 pulados (backups em arquivo, cópia na nuvem e partes que só existem no SQLite) |
| `npm run build:demo` | gerou `dist/` (3,1 MB); demonstração conferida no navegador |

Arquivos novos de teste, cada um rodado no SQLite e no PostgreSQL:

| Arquivo | Casos | SQLite | PostgreSQL |
| --- | --- | --- | --- |
| `tests/operator-auth.test.js` | A01–A07, regras do PIN, PIN fora do registro, selo das permissões | 9/9 | 9/9 |
| `tests/permissions.test.js` | P01–P10 e a matriz de rotas | 8/8 | 8/8 |
| `tests/blind-cash.test.js` | C01–C10 | 10/10 | 10/10 |
| `tests/authorization-http.test.js` | A08, 401 sem sessão, mudanças do administrador, cookie, auditoria §9, login da demonstração ausente na instalação | 6/6 | 6/6 (a instalação completa usa SQLite) |
| `tests/user-migration.test.js` | v5→v6 com vendas abertas, banco mais novo recusado, instalação em uso atualizada, backup/restauração, cópia na nuvem | 5/5 | 3/3 + 2 pulados (arquivos e nuvem são do SQLite) |

Também conferido no navegador, com uma pasta de dados descartável (`PDV_HOME` temporário, backup desligado):
- primeiro acesso, PIN pela tela nova, permissões por grupo;
- tela de entrada só com quem tem PIN, e PIN errado com mensagem genérica;
- operadora com 3 telas e preço só leitura;
- caixa cego sem valores, fechamento respondendo só `{"shiftId":1,"status":"FALTA","blind":true}` e o diálogo "Falta dinheiro";
- bloqueio do caixa;
- administrador no caixa vendo esperado, contado e diferença;
- layout de celular.

A demonstração foi conferida com as identidades de teste e a captura automática.

O instalador não foi alterado nem executado (ele exige administrador e mexe no programa instalado).

## 2. Critérios de aceite

| Critério | Como foi verificado | Situação |
| --- | --- | --- |
| O administrador atual continua entrando sem redefinição | `user-migration`: instalação em uso atualizada (v5/v1 → v6/v2), login com a mesma senha | ok |
| PIN individual por funcionário | `operator-auth` A01–A07; tela Usuários e permissões | ok |
| Administrador escolhe telas e ações; o servidor confere | `permissions` P01–P10, `authorization-http` | ok |
| Saldo esperado e diferença não saem do servidor para quem não pode ver | `blind-cash` C01, C05, C10 | ok |
| Fechamento cego só Conferido/Falta/Sobra | `blind-cash` C02–C04, C07 | ok |
| Ninguém opera como outra pessoa | P09; A06; identidade só da sessão | ok |
| Captura automática continua | `scale`, `open-sales`, `http`; demonstração | ok |
| Vendas abertas preservadas na atualização | `user-migration` (store e instalação completa) | ok |
| Permissões sobrevivem a sincronização e restauração | `user-migration` (backup, nuvem); selo exige revisão quando mudam | ok |
| Credenciais redefinidas com segurança depois de uma recuperação | `user-migration`: PINs não vão no backup; PIN novo no computador novo | ok |
| Testes no SQLite e no PGlite | seção 1 | ok |
| Funciona sem internet | tudo é local; `sync.test.js` (sem internet) | ok |
| Demonstração funciona | build + navegador | ok |
| Instalador preserva os dados | instalador não mudou; backup antes de atualizar obrigatório | ensaiar na loja |
| Versão antiga não opera calada no esquema novo | a partir desta versão sim (testado); a 0.2 não tem a trava (pendência 1) | ver pendência |

## 3. Roteiro na loja (para a homologação)

Antes de começar:
- [ ] Anotar a chave de recuperação dos backups e o código de recuperação do administrador.

Atualização:
- [ ] Atualizar com `instalador\instalar.bat` da versão nova.
- [ ] Conferir que o backup `*_atualizacao.luminorbackup` foi criado em `backups\seguranca`.
- [ ] Entrar pelo **Acesso do administrador** com a senha de sempre.
- [ ] Conferir o turno, as vendas abertas e os produtos.

Acessos:
- [ ] Em Usuários e permissões, dar PIN aos funcionários (perfil "operador padrão").
- [ ] Ajustar as permissões de quem fecha o caixa com conferência.
- [ ] Definir o limite da sangria sem conferência.
- [ ] Cada funcionário entra com o próprio PIN e confere as telas.
- [ ] Errar o PIN 5 vezes bloqueia por 5 minutos.

Caixa cego:
- [ ] Abrir o caixa com um fundo conhecido e vender em dinheiro.
- [ ] Fechar contando um valor diferente: a tela mostra só Falta ou Sobra.
- [ ] O administrador vê a diferença exata em Relatórios.

O que não deve funcionar:
- [ ] Um funcionário tentando Relatórios, preço, cancelamento ou a administração recebe "Peça ao administrador".
- [ ] A tentativa aparece no registro.

Troca de pessoa:
- [ ] Bloquear o caixa com uma venda aberta: ninguém mais opera.
- [ ] A mesma pessoa volta com o PIN e a venda continua.
- [ ] Com peso na balança, a troca de pessoa e a saída são recusadas.

Balança física:
- [ ] Captura automática com o funcionário conectado.
- [ ] Com o caixa bloqueado, o peso espera e entra quando a pessoa volta.

Recuperação:
- [ ] Restaurar o backup num computador de teste (com a chave).
- [ ] Ninguém entra até receber um PIN novo; depois as permissões são as do backup.

Supabase de homologação (**nunca o banco comercial**):
- [ ] Preparar, ativar a cópia e conferir que `employee_permissions` chega.
- [ ] Conferir que não existem tabelas de PIN nem de sessão na nuvem.

Rollback:
- [ ] Ensaiar o procedimento da seção 3.2 do README num computador de teste.
- [ ] Restaurar o backup "antes de atualizar" **antes de qualquer venda**.

Demonstração:
- [ ] Publicar no Netlify e conferir a tela de entrada com as identidades de teste.

## 4. Pendências e riscos encontrados

1. **A versão 0.2 não reconhece um banco mais novo.**
   - Se for reinstalada por cima dos dados atualizados, ela abre o banco v6 e volta a funcionar sem PIN, sem aviso.
   - Não dá para corrigir na 0.2 já instalada. A volta só é segura restaurando o backup "antes de atualizar" antes de vender (README 3.2).
   - Desta versão em diante a trava existe para os dois bancos e está testada.
2. **Caixa cego e Histórico.**
   - Com `screen.historico`, a operadora vê as vendas do caixa aberto com forma de pagamento e total.
   - Somando as vendas em dinheiro, daria para estimar o esperado (sem fundo, sangrias e suprimentos).
   - Decisão da loja: tirar o Histórico do perfil de quem fecha às cegas, ou aceitar.
3. **Vendas feitas pelo administrador no caixa ficam sem funcionário.**
   - Os relatórios por operador mostram "—".
   - O registro administrativo tem `venda_admin` com o número da venda.
4. **Não há correção de um fechamento já feito.** Por desenho, um turno fechado não reabre. Um erro de contagem fica registrado como diferença e é tratado fora do sistema.
5. **Sangria cega abaixo do limite pode passar do dinheiro na gaveta.**
   - É de propósito: a resposta não pode revelar o saldo.
   - O administrador vê o esperado negativo no fechamento. Recomenda-se um limite baixo.
6. **Perda do `config\cofre.dat`.**
   - O PIN e o selo das permissões usam uma chave guardada no cofre.
   - Sem o cofre, todos os PINs param de funcionar e todas as permissões pedem revisão.
   - O administrador define PINs novos e salva as permissões de cada um. As permissões em si não se perdem.
7. **Sessão da administração aberta.**
   - Ao bloquear o caixa, o cookie da administração é apagado do navegador, mas a sessão no servidor expira só com 15 minutos sem uso.
   - Um funcionário que entra com o PIN encerra todas as sessões da administração deste computador.
8. **Modo antigo com a nuvem como banco principal e vários computadores.**
   - O PIN e o selo ficam em cada computador.
   - Uma permissão alterada num computador pede revisão no outro.
   - O modo antigo é convertido sozinho para o banco local, e a cópia na nuvem é de um caixa só.
9. **Tela da administração para um funcionário.** Se um funcionário com a tela Configurações abrir a administração, a área volta para a tela de entrada do administrador (o servidor responde 403). Funciona, mas a mensagem pode ficar mais clara.
10. **Número da versão.**
    - `package.json` continua em 0.2.0.
    - Definir 0.3.0 (ou outro) antes de empacotar, para o instalador e o diagnóstico mostrarem a versão certa.
11. **Instalador.** Não foi alterado nem executado aqui. Criar a tarefa, ajustar as permissões da pasta e atualizar com dados reais devem ser ensaiados no computador da loja.
12. **Homologação no Supabase.** Migração e sincronização num projeto de homologação ficam com a usuária. Nunca o banco comercial.
13. **Balança física.** Continua sem teste de comunicação real (como antes).
