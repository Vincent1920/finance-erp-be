# Finance ERP Demo Data Matrix

Source of truth: migrations, validators, repositories, and production services in this repository.

| Module                     | Seed mechanism           |            Demo target | Supported statuses                                        | Notes                                                                                         |
| -------------------------- | ------------------------ | ---------------------: | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Company / user / RBAC      | Safe master upsert       |    1 / 1 / super-admin | active                                                    | Dedicated demo login; production execution is rejected.                                       |
| Chart of Accounts          | Safe master upsert       |   24+ posting accounts | active/inactive                                           | Includes AR, AP, VAT input/output, inventory, revenue, COGS, bank, expense, equity accounts.  |
| Periods                    | Safe master upsert       |       12 months (2026) | open                                                      | Required by posting services.                                                                 |
| Customers / suppliers      | Safe master upsert       |                20 / 15 | active/inactive                                           | Control-account and IDR currency mappings are populated.                                      |
| Units / warehouses         | Safe master upsert       |                  5 / 3 | active                                                    | Warehouse schema supports address, but not PIC, phone, or type.                               |
| Tax codes                  | Safe master upsert       |                      3 | active                                                    | `PPN-IN` and `PPN-OUT` use the actual VAT schema and mapped tax accounts.                     |
| Cost centers / projects    | Safe master upsert       |                  5 / 5 | active                                                    | Project status is a free-form VARCHAR; demo uses `active` and `completed`.                    |
| Bank accounts              | Safe master upsert       |                      2 | active                                                    | Mapped to posting bank GL accounts; account numbers are synthetic.                            |
| Items                      | Safe master upsert       |                     30 | active/inactive                                           | 20 inventory items and 10 services, including zero-stock inventory items for UI filters.      |
| Bank statements            | `BankStatementService`   |            1 / 4 lines | imported/unmatched                                        | Deterministic statement and running balance; no reconciliation state is fabricated.           |
| Opening GL                 | `OpeningBalanceService`  |       1 balanced batch | validated                                                 | Stored through the dedicated opening-balance mechanism.                                       |
| Opening inventory          | `OpeningBalanceService`  | 21 item/warehouse rows | validated                                                 | Creates inventory movements through `InventoryCostingService`; never edits balances directly. |
| Purchase orders            | `PurchaseOrderService`   |                      4 | draft/confirmed/completed                                 | References contain `PUR-PO-DEMO-*`.                                                           |
| Goods receipts             | `GoodsReceiptService`    |                      3 | posted                                                    | Includes a 6 + 4 partial/full receipt scenario.                                               |
| Purchase invoices          | `PurchaseInvoiceService` |                      8 | draft/pending_approval/approved/rejected/posted/cancelled | Paid states are blocked because no production supplier-payment service/route exists.          |
| Sales orders               | `SalesOrderService`      |                      4 | draft/confirmed/cancelled                                 | References contain `SO-DEMO-*`.                                                               |
| Sales invoices             | `SalesInvoiceService`    |                     12 | draft/pending_approval/approved/rejected/posted/cancelled | Paid states are blocked because no production customer-payment service/route exists.          |
| Sales returns              | `SalesReturnService`     |              2 / 2 lines | approved                                                  | Partial and full-line scenarios use posted source invoices and production validation.         |
| Manual journals            | `JournalService`         |                     10 | draft/pending_approval/approved/rejected/posted           | All payloads are balanced before persistence.                                                 |
| Invalid scenarios          | Fixtures only            |               12 cases | not persisted                                             | JSON payloads and invalid CSV are isolated under `database/demo-fixtures`.                    |
| Import samples             | CSV/XLSX files           |                8 pairs | upload fixtures                                           | Headers follow `ImportDefinitions.ts`; includes a bank-statement fixture.                      |
| Purchase returns           | none                     |                blocked | —                                                         | No production purchase-return service/controller is implemented.                              |
| Customer/supplier payments | none                     |                blocked | —                                                         | Tables exist, but production services/routes are absent; the seed does not bypass them.       |

Idempotency keys are company plus stable demo code/reference. Transaction services are only called when the corresponding demo reference is absent.

## Schema inventory classification

| Status | Tables |
| --- | --- |
| OK | companies, users, roles, permissions, user_roles, role_permissions, accounting_periods, accounts, settings, number_sequences, customers, suppliers, units, warehouses, tax_codes, cost_centers, projects, items, bank_accounts, opening_balance_batches, opening_balance_lines, sales_orders, sales_order_lines, purchase_orders, purchase_order_lines, goods_receipts, goods_receipt_lines, sales_invoices, sales_invoice_lines, purchase_invoices, purchase_invoice_lines, journals, journal_lines, inventory_balances, inventory_movements, bank_statements, bank_statement_lines, audit_logs |
| RUNTIME_GENERATED | approval_requests, approval_steps, approval_histories, recurring_journal_runs, attachments, import_jobs, import_job_rows, import_job_errors, export_jobs, backup_jobs, restore_jobs, error_logs |
| PARTIAL / BLOCKED | currencies, company_currencies, exchange_rates, account_mappings, delivery_orders, delivery_order_lines, sales_invoice_deliveries, purchase_invoice_receipts, purchase_returns, purchase_return_lines, customer_payments, customer_payment_allocations, supplier_payments, supplier_payment_allocations, stock_transfers, stock_transfer_lines, stock_adjustments, stock_adjustment_lines, approval_rules, approval_rule_steps, bank_reconciliations, bank_reconciliation_matches, cash_transfers, fixed_asset_categories, fixed_assets, asset_depreciations, budgets, budget_lines, recurring_journals, recurring_journal_lines, period_close_runs, period_close_checks, year_end_closings, year_end_closing_lines, document_templates |
| SYSTEM / NOT_APPLICABLE | migrations |

`PARTIAL / BLOCKED` means the schema exists but the current production application does not expose a complete create/post workflow. The demo seed intentionally does not insert directly into these tables.
