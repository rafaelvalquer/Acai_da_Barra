# Conferência de fechamento e impressão térmica (Elgin i9)

Banco comercial: versão **8** (v7: `shift_reconciliations`, `shift_reconciliation_items`; v8: `sale_payments`, ver docs/pagamento-dividido.md). `config\admin.sqlite`: versão **3** (`print_jobs`, só neste computador).

> **Estado da homologação: PENDENTE.** O envio para a impressora foi testado apenas com uma impressora simulada (fila do Windows falsa).
> Nada foi impresso na Elgin i9 real e o envio pela tarefa agendada (conta SYSTEM) não foi testado. Não dê a Elgin i9 como homologada antes de cumprir a seção 6.

## 1. O que mudou no fechamento

- O funcionário conta e digita **quatro valores**: dinheiro, Pix, crédito e débito (0,00 vale). Em seguida revisa e confirma.
- Antes da confirmação o servidor **não envia** total, valor esperado, diferença nem prévia, em nenhuma rota. A permissão antiga `cash.view_expected` deixou de abrir os totais do turno em andamento (modo rigoroso, ligado por padrão; o administrador pode desligar em Usuários e permissões).
- O histórico de vendas do turno aberto omite a forma de pagamento para quem fecha às cegas (somar por forma revelaria os totais).
- Na confirmação, uma única transação grava o esperado (snapshot), os quatro itens e fecha o turno. Repetir a mesma chave de idempotência devolve o mesmo fechamento.
- Depois do commit, quem fechou recebe o relatório **daquele** fechamento: informado, sistema e diferença por forma, totais, faturamento e movimento de dinheiro.
- O fechamento antigo de um valor (`counted: "250,00"`) continua aceito e fica marcado como "antigo" no histórico.

## 2. Permissões

| Permissão | Padrão do operador | Observação |
| --- | --- | --- |
| `cash.reconciliation.confirm` | sim | confirmar a contagem |
| `cash.reconciliation.view_confirmed` | sim | ver o próprio fechamento depois de confirmado |
| `cash.reconciliation.print` / `reprint` | sim | imprimir e reimprimir |
| `cash.reconciliation.reopen` / `correct` / `view_revisions` | não (críticas) | só o administrador, com a senha dele |

Quem já podia fechar (`cash.close`) continua podendo confirmar, ver e imprimir o próprio fechamento, a menos que o administrador tenha recusado a permissão explicitamente. Ver o fechamento de outra pessoa exige `cash.view_history`.

## 3. Rotas

`POST /api/shift/close/begin`, `POST /api/shift/close`, `GET /api/shift/closings`, `GET /api/shift/closings/report`, `GET /api/shift/closings/print-status`, `POST /api/shift/closings/print` (`reprint:true` para 2ª via), `POST /api/shift/closings/reopen`, `POST /api/shift/closings/correct`, `GET /api/shift/closings/revisions`.
Administração: `GET /api/admin/printers`, `POST /api/admin/printers/settings|test|cancel`.

Reabrir e corrigir pedem justificativa (mínimo 5 letras) e a senha do administrador. A correção cria uma **nova revisão** (a anterior fica guardada, marcada como substituída) e mantém o mesmo valor esperado do fechamento original.

## 4. Impressão

Ordem de preferência: (1) fila do Windows (RAW, via PowerShell e `winspool.drv`, sem janela e sem COM), (2) Elgin E1 (desativado: não será adotado sem prova em equipamento), (3) diálogo de impressão do navegador (texto monoespaçado em 72 mm).

- Relatório de 80 mm, 48 colunas por padrão (32 a 64), ESC/POS com página de código **PC860**. Cabeçalho e rodapé configuráveis. O corte só é enviado depois de marcado "o corte foi testado nesta impressora".
- Fila persistente em `config\admin.sqlite`: `PENDING`, `SPOOLING`, `SUBMITTED`, `FAILED`, `CANCELED`. **SUBMITTED** significa que o spooler aceitou, não que o papel saiu.
- Imprimir o mesmo fechamento duas vezes não duplica: a segunda é uma **2ª VIA** marcada no papel. A impressão automática nunca repete.
- Falha comum (impressora desligada, spooler parado): o fechamento continua confirmado; a mensagem diz o motivo e o botão **Imprimir** tenta de novo.
- Resultado duvidoso (tempo esgotado, reinício do PDV durante o envio): o job vira `FAILED` duvidoso e uma nova via só sai com confirmação da pessoa, depois de conferir o papel.

### Configurar (administrador)

1. Instale o driver da Elgin i9 no Windows e confirme que a fila aparece em *Impressoras e scanners*.
2. Administração → **Configurações** → *Impressora de fechamento*: escolha a fila (a lista vem do Windows), modelo e colunas, e salve.
3. **Imprimir teste** (acentos, largura, valores negativos). Só depois ligue *Imprimir ao confirmar o fechamento*.
4. Para o corte: **Teste com corte**; se funcionou, marque "corte testado" e então "cortar o papel".

### Depois de atualizar o Windows ou o driver

Rode **Imprimir teste** de novo. Se a fila mudou de nome, escolha-a outra vez. Se o spooler estiver parado, inicie o serviço *Spooler de Impressão*.

## 5. Voltar atrás

O programa antigo não abre o banco v7 (a trava de versão recusa). Para voltar: restaure o backup feito antes da atualização (README, seção 5). Os fechamentos já confirmados na v7 não existem no backup antigo. Desligar apenas a impressão: desmarque *Imprimir ao confirmar* ou escolha a forma de envio *navegador*; o fechamento não depende dela.

## 6. Checklist de homologação física (pendente)

- [ ] Imprimir o teste na Elgin i9 pela fila do Windows: acentos (ç ã é ê í õ ú) corretos em PC860, 48 colunas sem quebra.
- [ ] Imprimir um fechamento completo (original) e uma 2ª via; conferir os banners.
- [ ] Teste com corte e sem corte; confirmar o comportamento do cortador.
- [ ] Impressora desligada / sem papel / tampa aberta: mensagem clara e fechamento intacto.
- [ ] Cabo USB desconectado durante o envio; reconectar e reimprimir.
- [ ] Reiniciar o PDV logo após confirmar (job duvidoso, nenhuma via sai sozinha).
- [ ] **Executar pela tarefa agendada (conta SYSTEM):** a conta precisa enxergar a fila. Se a fila é por usuário, compartilhar/instalar para todos os usuários.
- [ ] Atualização do Windows ou do driver: repetir o teste.
- [ ] Computador sem internet: fechar e imprimir normalmente.
- [ ] Dois cliques e dois terminais confirmando o mesmo fechamento: um só fechamento, uma só impressão.

Itens marcados só depois de feitos em equipamento real.
