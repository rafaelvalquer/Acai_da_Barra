# Pagamento dividido por várias formas

Banco comercial: versão **8** (`sale_payments`). Uma venda pode ser quitada por **1 a 4 parcelas**, no máximo uma por forma (`cash`, `pix`, `credit`, `debit`).

> **Estado da homologação: PENDENTE.** Tudo abaixo foi testado com testes automatizados (SQLite e PostgreSQL/PGlite) e na demonstração do navegador.
> Não foi instalado nem testado no computador da loja. Não dê o recurso como homologado antes de cumprir a seção 7.

## 1. Regras

- Valores sempre em **centavos inteiros**. A soma das parcelas tem de ser **exatamente** o total que o **servidor** calcula pelos itens (o navegador nunca decide o total).
- Recusado, sem gravar nada: nenhuma parcela, forma desconhecida ou repetida, valor negativo, zero, ausente ou malformado, soma menor ou maior que o total, mais de 4 parcelas, dinheiro recebido menor que a parcela em dinheiro, recebido informado em forma que não é dinheiro, carrinho alterado depois da conferência (revisão), caixa fechado, venda já cobrada.
- **Troco = recebido − parcela em dinheiro** (nunca o total da venda). O recebido é opcional; sem ele não há troco registrado.
- Sem parcelamento de cartão e sem TEF/Pix automático: o operador confirma que recebeu cada parcela.
- `sales.method` guarda a forma da venda de uma parcela só, ou `mixed` quando há mais de uma (apenas para exibição: "Misto"). Quem manda nos valores é `sale_payments`.
- Cancelar uma venda **preserva** as parcelas; elas saem dos totais válidos (fechamento e relatórios contam só vendas concluídas). Corrigir uma venda cria um novo atendimento aberto: o pagamento é feito de novo, com nova distribuição.
- Um pagamento nunca é transferido de uma venda para outra.

## 2. Banco de dados (migração v8)

`sale_payments(id, uuid único, sale_id → sales, method, amount_cents > 0, received_cents, change_cents, created_at)`, `UNIQUE(sale_id, method)`; `received_cents`/`change_cents` só existem na parcela em dinheiro e `change = received − amount`.

A migração (SQLite e PostgreSQL, em transação) cria a tabela e **preenche uma linha para cada venda existente** (inclusive canceladas): a forma e o total da venda; no dinheiro, copia recebido e troco. Não altera estoque, turnos nem fechamentos antigos (os snapshots de `shift_reconciliations` continuam como foram gravados). Pode rodar de novo sem duplicar (só preenche vendas sem parcela).

Também cobertos: exportação SQLite → PostgreSQL (`TABLES` com `since: 8`), cópia na nuvem (triggers e envio gerados do mesmo `TABLES`; a nuvem em versão antiga é atualizada e recebe o banco inteiro), backup/validador/restauração (um backup da versão 7 restaurado **reconstrói as parcelas**), e o resumo do banco (`payments.unbalancedSales` deve ser sempre 0).

Verificação de integridade (deve voltar vazio):

```sql
-- venda concluída cuja soma das parcelas difere do total (ou sem parcelas)
SELECT s.id FROM sales s WHERE s.status='done'
  AND s.total_cents <> COALESCE((SELECT SUM(p.amount_cents) FROM sale_payments p WHERE p.sale_id=s.id), -1);
-- parcelas órfãs
SELECT p.id FROM sale_payments p WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id=p.sale_id);
```

## 3. API

`POST /api/checkout` (permissão `sales.checkout`, inalterada). Contrato novo:

```json
{ "saleId": "…", "revision": 7, "uuid": "id-da-cobranca-12-a-80-caracteres",
  "payments": [ { "method": "cash", "amount": "20,00", "received": "50,00" }, { "method": "pix", "amount": "30,00" } ] }
```

O contrato anterior (`method` + `received`) continua valendo e grava uma parcela. Enviar `method` junto com `payments` só é aceito se concordar (uma parcela da mesma forma); `received` fora da parcela em dinheiro é recusado quando há `payments`.

Resposta: `{ sale, duplicate, activeSaleId }`, com `sale.payments = [{ method, label, amountCents, receivedCents, changeCents }]` (ordem fixa: dinheiro, Pix, crédito, débito). Repetir a mesma cobrança (mesmo `uuid`, ou a mesma venda aberta com outro `uuid`, inclusive depois de reiniciar o PDV) devolve a **primeira** venda com `duplicate: true`; uma repetição com parcelas diferentes **não** substitui o pagamento já feito. Tudo (venda, itens, parcelas, estoque baixado uma vez, conclusão do atendimento, próximo atendimento) é uma transação.

`GET /api/sales/detail` traz `payments`. A lista do histórico mostra "Misto" em `method`.

## 4. Caixa cego

`src/auth/CashVisibilityPolicy.js` zera `method`, `received_cents`, `change_cents` e `payments` do histórico, do detalhe e das respostas de cancelar/corrigir para quem não vê o esperado — **em qualquer período**, não só no turno aberto (antes, quem tinha só `reports.view` via a forma de cada venda). O relatório continua sem `methods` nem lista de vendas. Quem cobra vê a própria cobrança na resposta do checkout. O fechamento cego não mudou.

## 5. Fechamento e relatórios

- `CashRepository.salesByMethod()` agora soma `sale_payments.amount_cents` das vendas concluídas do turno (JOIN); a contagem de vendas vem de `sales` (`salesCounts`), então uma venda com 4 parcelas conta **uma vez**.
- Esperado por forma = soma das parcelas; dinheiro esperado = fundo + parcelas em dinheiro + suprimentos − sangrias.
- O relatório da Elgin i9 imprime o snapshot do fechamento (`ThermalReceiptBuilder` não mudou); os testes conferem os quatro valores a partir de vendas divididas.
- Relatórios dia/semana/mês: faturamento por `sales.total_cents`, distribuição por forma por `sale_payments.amount_cents`; ticket médio, itens, peso, operador e cancelamentos como antes.

## 6. Tela

Em **Vender**, os 4 botões continuam e há **Dividir pagamento**: janela com o total, 4 campos, soma, restante, "Preencher restante", dinheiro recebido com atalhos e troco, uma revisão ("Confirmar recebimento e finalizar venda") e botão desabilitado durante o envio. O `uuid` fica o mesmo enquanto a mesma venda e o mesmo total estão abertos (retentativa não cobra duas vezes); se o total mudar (pesagem nova), a janela volta para a edição com o novo total; os valores nunca passam de uma venda para outra.

## 7. Homologação (computador da loja)

Marque cada item. Nenhum foi executado no computador da cliente.

- [ ] Atualizar o PDV (seção 8) e conferir que o banco ficou na versão 8 (Administração → Banco de dados).
- [ ] Vendas antigas continuam no histórico, com a mesma forma e o mesmo total; um fechamento antigo abre igual.
- [ ] Venda de R$ 40,00: R$ 10,00 em dinheiro (recebido R$ 50,00 → troco R$ 40,00) + R$ 30,00 em Pix. Histórico mostra "Misto" e as duas parcelas.
- [ ] Soma menor, soma maior, forma repetida e cinco formas são recusadas com mensagem clara; nada é cobrado.
- [ ] Duplo clique em "Confirmar recebimento e finalizar venda" gera **uma** venda.
- [ ] Adicionar uma pesagem com a janela aberta volta para a edição com o novo total.
- [ ] Cancelar a venda mista: sai do fechamento e dos relatórios; as parcelas continuam no detalhe (administrador).
- [ ] Fechar o caixa (com um operador sem permissão de ver o esperado): só Conferido/Falta/Sobra aparece; o histórico dele não mostra forma nem parcelas.
- [ ] Fechamento do administrador: dinheiro esperado = fundo + dinheiro das parcelas + suprimentos − sangrias; Pix, crédito e débito = soma das parcelas.
- [ ] Imprimir o fechamento na Elgin i9 e comparar com a tela.
- [ ] Backup antes e depois; restaurar o de antes e conferir que as parcelas são reconstruídas.
- [ ] Com a cópia na nuvem ligada: as parcelas chegam à nuvem (o PDV envia o banco inteiro uma vez após a atualização).

## 8. Atualização no Windows

1. Faça um **backup manual** (Administração → Backup) e guarde também a chave de recuperação.
2. Feche o caixa do dia (não atualize com um caixa aberto).
3. Rode o instalador novo. Ao abrir, o PDV migra o banco para a versão 8 sozinho (as parcelas das vendas antigas são criadas nessa hora).
4. Abra o PDV e confira o item 1 da homologação.

## 9. Voltar atrás (rollback)

O programa anterior **recusa** um banco da versão 8 ("banco de versão mais nova"), por segurança. Para voltar: reinstale a versão anterior e **restaure o backup feito no passo 1 da atualização** (versão 7). Vendas feitas depois da atualização não existiriam nesse backup: se houver vendas novas que precisem ser mantidas, não volte; abra um chamado para uma correção em vez de apagar `sale_payments` na mão. A tabela `sale_payments` não deve ser removida de um banco em uso (o fechamento e os relatórios dependem dela).

## 10. Testes

`tests/payment-service.test.js` (regras), `split-checkout.test.js` (checkout, idempotência, rollback, cancelamento, correção, reinício), `split-checkout-http.test.js` (contrato, permissão, caixa cego), `split-payment-migration.test.js` (v7 → v8), `split-payment-reconciliation.test.js`, `split-payment-report.test.js`, `split-payment-backup.test.js` (backup v8 e v7, exportação, cópia na nuvem sem internet). `npm test` e `npm run test:postgres`.
