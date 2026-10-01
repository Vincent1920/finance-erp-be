import type { MigrationDatabase } from './helpers'
import { addColumnIfMissing, dropColumnIfExists, dropTables } from './helpers'

const lineTables = ['sales_invoice_lines','purchase_invoice_lines','sales_order_lines','purchase_order_lines','sales_return_lines','purchase_return_lines','stock_transfer_lines'] as const

export const migration = {
  name: '011_phase_one_two_controls',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS item_units(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      item_id BIGINT UNSIGNED NOT NULL,
      unit_id BIGINT UNSIGNED NOT NULL,
      factor_to_stock DECIMAL(20,6) NOT NULL,
      is_purchase BOOLEAN NOT NULL DEFAULT TRUE,
      is_sales BOOLEAN NOT NULL DEFAULT TRUE,
      barcode VARCHAR(100) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_item_unit(item_id,unit_id),
      UNIQUE KEY uq_item_barcode(company_id,barcode),
      CONSTRAINT fk_item_unit_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_item_unit_item FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
      CONSTRAINT fk_item_unit_unit FOREIGN KEY(unit_id) REFERENCES units(id),
      CHECK(factor_to_stock>0),
      INDEX idx_item_unit_lookup(company_id,item_id,is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.query(`INSERT IGNORE INTO item_units(company_id,item_id,unit_id,factor_to_stock,is_purchase,is_sales)
      SELECT company_id,id,unit_id,1,TRUE,TRUE FROM items`)
    for (const table of lineTables) {
      await addColumnIfMissing(db,table,'stock_quantity','DECIMAL(20,4) NULL')
      await db.query(`UPDATE ${table} SET stock_quantity=quantity WHERE stock_quantity IS NULL`)
    }

    await db.query(`CREATE TABLE IF NOT EXISTS party_credits(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      credit_number VARCHAR(50) NOT NULL,
      party_type ENUM('customer','supplier') NOT NULL,
      party_id BIGINT UNSIGNED NOT NULL,
      source_type ENUM('invoice_excess','opening') NOT NULL DEFAULT 'invoice_excess',
      source_id BIGINT UNSIGNED NULL,
      credit_date DATE NOT NULL,
      currency CHAR(3) NOT NULL,
      exchange_rate DECIMAL(20,8) NOT NULL,
      control_account_id BIGINT UNSIGNED NOT NULL,
      original_amount DECIMAL(20,2) NOT NULL,
      remaining_amount DECIMAL(20,2) NOT NULL,
      status ENUM('open','partially_used','used','void') NOT NULL DEFAULT 'open',
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_party_credit_number(company_id,credit_number),
      UNIQUE KEY uq_party_credit_source(company_id,party_type,source_type,source_id),
      CONSTRAINT fk_party_credit_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_party_credit_control FOREIGN KEY(control_account_id) REFERENCES accounts(id),
      CONSTRAINT fk_party_credit_created FOREIGN KEY(created_by) REFERENCES users(id),
      CHECK(original_amount>=0 AND remaining_amount>=0 AND remaining_amount<=original_amount),
      INDEX idx_party_credit_party(company_id,party_type,party_id,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.query(`CREATE TABLE IF NOT EXISTS party_credit_applications(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      party_credit_id BIGINT UNSIGNED NOT NULL,
      application_type ENUM('invoice','refund') NOT NULL,
      target_invoice_id BIGINT UNSIGNED NULL,
      application_date DATE NOT NULL,
      amount DECIMAL(20,2) NOT NULL,
      base_amount DECIMAL(20,2) NOT NULL,
      cash_account_id BIGINT UNSIGNED NULL,
      bank_account_id BIGINT UNSIGNED NULL,
      reference VARCHAR(100) NULL,
      journal_id BIGINT UNSIGNED NULL,
      reversal_journal_id BIGINT UNSIGNED NULL,
      status ENUM('posted','reversed') NOT NULL DEFAULT 'posted',
      created_by BIGINT UNSIGNED NOT NULL,
      reversed_by BIGINT UNSIGNED NULL,
      reversed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_credit_application_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_credit_application_credit FOREIGN KEY(party_credit_id) REFERENCES party_credits(id),
      CONSTRAINT fk_credit_application_cash FOREIGN KEY(cash_account_id) REFERENCES accounts(id),
      CONSTRAINT fk_credit_application_bank FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id),
      CONSTRAINT fk_credit_application_journal FOREIGN KEY(journal_id) REFERENCES journals(id) ON DELETE SET NULL,
      CONSTRAINT fk_credit_application_reversal FOREIGN KEY(reversal_journal_id) REFERENCES journals(id) ON DELETE SET NULL,
      CONSTRAINT fk_credit_application_created FOREIGN KEY(created_by) REFERENCES users(id),
      CONSTRAINT fk_credit_application_reversed_by FOREIGN KEY(reversed_by) REFERENCES users(id) ON DELETE SET NULL,
      CHECK(amount>0 AND base_amount>0),
      INDEX idx_credit_application_credit(party_credit_id,status),
      INDEX idx_credit_application_invoice(company_id,target_invoice_id,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS user_saved_views(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      screen_key VARCHAR(100) NOT NULL,
      name VARCHAR(100) NOT NULL,
      filters JSON NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_saved_view(company_id,user_id,screen_key,name),
      CONSTRAINT fk_saved_view_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_saved_view_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_saved_view_screen(company_id,user_id,screen_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  },
  async down(db: MigrationDatabase) {
    await dropTables(db,['user_saved_views','party_credit_applications','party_credits','item_units'])
    for (const table of [...lineTables].reverse()) await dropColumnIfExists(db,table,'stock_quantity')
  },
}
