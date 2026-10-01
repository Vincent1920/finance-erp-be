import type { MigrationDatabase } from './helpers'
import { dropTables } from './helpers'

export const migration = {
  name: '016_payroll',
  async up(db: MigrationDatabase) {
    await db.query(`CREATE TABLE IF NOT EXISTS payroll_policies(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      health_employee_rate DECIMAL(9,6) NOT NULL DEFAULT 0.01,
      health_employer_rate DECIMAL(9,6) NOT NULL DEFAULT 0.04,
      health_wage_cap DECIMAL(20,2) NOT NULL DEFAULT 12000000,
      jht_employee_rate DECIMAL(9,6) NOT NULL DEFAULT 0.02,
      jht_employer_rate DECIMAL(9,6) NOT NULL DEFAULT 0.037,
      jp_employee_rate DECIMAL(9,6) NOT NULL DEFAULT 0.01,
      jp_employer_rate DECIMAL(9,6) NOT NULL DEFAULT 0.02,
      jp_wage_cap DECIMAL(20,2) NOT NULL DEFAULT 10547400,
      jkk_employer_rate DECIMAL(9,6) NOT NULL DEFAULT 0.0024,
      jkm_employer_rate DECIMAL(9,6) NOT NULL DEFAULT 0.003,
      salary_expense_account_id BIGINT UNSIGNED NULL,
      employer_bpjs_expense_account_id BIGINT UNSIGNED NULL,
      payroll_payable_account_id BIGINT UNSIGNED NULL,
      bpjs_payable_account_id BIGINT UNSIGNED NULL,
      pph21_payable_account_id BIGINT UNSIGNED NULL,
      employee_loan_account_id BIGINT UNSIGNED NULL,
      other_deduction_account_id BIGINT UNSIGNED NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_policy(company_id,effective_from),
      CONSTRAINT fk_payroll_policy_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_payroll_policy_user FOREIGN KEY(created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS payroll_ter_rates(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      category ENUM('A','B','C') NOT NULL,
      gross_from DECIMAL(20,2) NOT NULL,
      gross_to DECIMAL(20,2) NULL,
      rate DECIMAL(9,6) NOT NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      CONSTRAINT fk_payroll_ter_company FOREIGN KEY(company_id) REFERENCES companies(id),
      INDEX idx_payroll_ter(company_id,category,effective_from,gross_from)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS payroll_employees(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      employee_number VARCHAR(40) NOT NULL,
      name VARCHAR(191) NOT NULL,
      nik VARCHAR(20) NULL,
      npwp VARCHAR(16) NULL,
      email VARCHAR(191) NULL,
      department VARCHAR(100) NULL,
      position VARCHAR(100) NULL,
      employment_type ENUM('permanent','contract','non_employee') NOT NULL DEFAULT 'permanent',
      ptkp_status VARCHAR(10) NOT NULL DEFAULT 'TK/0',
      ter_category ENUM('A','B','C') NOT NULL DEFAULT 'A',
      hire_date DATE NOT NULL,
      termination_date DATE NULL,
      bank_name VARCHAR(100) NULL,
      bank_account_number VARCHAR(100) NULL,
      bank_account_name VARCHAR(191) NULL,
      bpjs_health_number VARCHAR(50) NULL,
      bpjs_employment_number VARCHAR(50) NULL,
      basic_salary DECIMAL(20,2) NOT NULL DEFAULT 0,
      fixed_allowance DECIMAL(20,2) NOT NULL DEFAULT 0,
      prior_year_income DECIMAL(20,2) NOT NULL DEFAULT 0,
      prior_year_tax DECIMAL(20,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_employee(company_id,employee_number),
      CONSTRAINT fk_payroll_employee_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_payroll_employee_user FOREIGN KEY(created_by) REFERENCES users(id),
      INDEX idx_payroll_employee(company_id,is_active,name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS payroll_runs(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      number VARCHAR(50) NOT NULL,
      period CHAR(7) NOT NULL,
      date_from DATE NOT NULL,
      date_to DATE NOT NULL,
      pay_date DATE NOT NULL,
      status ENUM('draft','calculated','approved','posted','paid','locked') NOT NULL DEFAULT 'draft',
      notes VARCHAR(1000) NULL,
      total_gross DECIMAL(20,2) NOT NULL DEFAULT 0,
      total_operational_deductions DECIMAL(20,2) NOT NULL DEFAULT 0,
      total_employee_bpjs DECIMAL(20,2) NOT NULL DEFAULT 0,
      total_employer_bpjs DECIMAL(20,2) NOT NULL DEFAULT 0,
      total_pph21 DECIMAL(20,2) NOT NULL DEFAULT 0,
      total_take_home_pay DECIMAL(20,2) NOT NULL DEFAULT 0,
      total_company_cost DECIMAL(20,2) NOT NULL DEFAULT 0,
      journal_id BIGINT UNSIGNED NULL,
      payment_journal_id BIGINT UNSIGNED NULL,
      payment_account_id BIGINT UNSIGNED NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      approved_by BIGINT UNSIGNED NULL,
      approved_at DATETIME NULL,
      posted_by BIGINT UNSIGNED NULL,
      posted_at DATETIME NULL,
      paid_by BIGINT UNSIGNED NULL,
      paid_at DATETIME NULL,
      locked_by BIGINT UNSIGNED NULL,
      locked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_run_number(company_id,number),
      UNIQUE KEY uq_payroll_run_period(company_id,period),
      CONSTRAINT fk_payroll_run_company FOREIGN KEY(company_id) REFERENCES companies(id),
      CONSTRAINT fk_payroll_run_user FOREIGN KEY(created_by) REFERENCES users(id),
      CONSTRAINT fk_payroll_run_journal FOREIGN KEY(journal_id) REFERENCES journals(id) ON DELETE SET NULL,
      CONSTRAINT fk_payroll_run_payment_journal FOREIGN KEY(payment_journal_id) REFERENCES journals(id) ON DELETE SET NULL,
      INDEX idx_payroll_run(company_id,period,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`CREATE TABLE IF NOT EXISTS payroll_entries(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      run_id BIGINT UNSIGNED NOT NULL,
      employee_id BIGINT UNSIGNED NOT NULL,
      basic_salary DECIMAL(20,2) NOT NULL DEFAULT 0,
      fixed_allowance DECIMAL(20,2) NOT NULL DEFAULT 0,
      variable_allowance DECIMAL(20,2) NOT NULL DEFAULT 0,
      overtime DECIMAL(20,2) NOT NULL DEFAULT 0,
      bonus DECIMAL(20,2) NOT NULL DEFAULT 0,
      thr DECIMAL(20,2) NOT NULL DEFAULT 0,
      rapel DECIMAL(20,2) NOT NULL DEFAULT 0,
      reimbursement DECIMAL(20,2) NOT NULL DEFAULT 0,
      absence_deduction DECIMAL(20,2) NOT NULL DEFAULT 0,
      loan_deduction DECIMAL(20,2) NOT NULL DEFAULT 0,
      other_deduction DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_health_employee DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_jht_employee DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_jp_employee DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_health_employer DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_jht_employer DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_jp_employer DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_jkk_employer DECIMAL(20,2) NOT NULL DEFAULT 0,
      bpjs_jkm_employer DECIMAL(20,2) NOT NULL DEFAULT 0,
      taxable_gross DECIMAL(20,2) NOT NULL DEFAULT 0,
      ter_rate DECIMAL(9,6) NOT NULL DEFAULT 0,
      pph21 DECIMAL(20,2) NOT NULL DEFAULT 0,
      pph21_override DECIMAL(20,2) NULL,
      gross_earnings DECIMAL(20,2) NOT NULL DEFAULT 0,
      operational_deductions DECIMAL(20,2) NOT NULL DEFAULT 0,
      employee_bpjs DECIMAL(20,2) NOT NULL DEFAULT 0,
      employer_bpjs DECIMAL(20,2) NOT NULL DEFAULT 0,
      take_home_pay DECIMAL(20,2) NOT NULL DEFAULT 0,
      company_cost DECIMAL(20,2) NOT NULL DEFAULT 0,
      calculation_note VARCHAR(500) NULL,
      UNIQUE KEY uq_payroll_entry(run_id,employee_id),
      CONSTRAINT fk_payroll_entry_run FOREIGN KEY(run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
      CONSTRAINT fk_payroll_entry_employee FOREIGN KEY(employee_id) REFERENCES payroll_employees(id),
      INDEX idx_payroll_entry_employee(employee_id,run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

    await db.query(`INSERT IGNORE INTO permissions(module,action,name,slug)
      SELECT 'payroll',a.action,CONCAT(a.action,' payroll'),CONCAT('payroll.',a.action)
      FROM (SELECT 'view' action UNION ALL SELECT 'create' UNION ALL SELECT 'update' UNION ALL SELECT 'calculate' UNION ALL SELECT 'approve' UNION ALL SELECT 'post' UNION ALL SELECT 'pay' UNION ALL SELECT 'lock' UNION ALL SELECT 'manage' UNION ALL SELECT 'export') a`)
    await db.query(`INSERT IGNORE INTO role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
      WHERE r.slug='super-admin' AND p.module='payroll'`)

    await db.query(`INSERT IGNORE INTO payroll_policies(company_id,effective_from,created_by,
      salary_expense_account_id,employer_bpjs_expense_account_id,payroll_payable_account_id,bpjs_payable_account_id,pph21_payable_account_id,employee_loan_account_id,other_deduction_account_id)
      SELECT c.id,'2026-01-01',MIN(u.id),
        (SELECT id FROM accounts WHERE company_id=c.id AND code IN ('6101','6100') ORDER BY code DESC LIMIT 1),
        (SELECT id FROM accounts WHERE company_id=c.id AND account_type='expense' ORDER BY code LIMIT 1),
        (SELECT id FROM accounts WHERE company_id=c.id AND account_type='liability' ORDER BY code LIMIT 1),
        (SELECT id FROM accounts WHERE company_id=c.id AND account_type='liability' ORDER BY code LIMIT 1),
        (SELECT id FROM accounts WHERE company_id=c.id AND account_type='liability' ORDER BY code LIMIT 1),
        (SELECT id FROM accounts WHERE company_id=c.id AND account_type='asset' ORDER BY code LIMIT 1),
        (SELECT id FROM accounts WHERE company_id=c.id AND account_type='liability' ORDER BY code LIMIT 1)
      FROM companies c JOIN users u ON u.company_id=c.id GROUP BY c.id`)

    await db.query(`INSERT IGNORE INTO payroll_employees(company_id,employee_number,name,nik,npwp,email,department,position,ptkp_status,ter_category,hire_date,bank_name,bank_account_number,bank_account_name,bpjs_health_number,bpjs_employment_number,basic_salary,fixed_allowance,created_by)
      SELECT c.id,x.employee_number,x.name,x.nik,x.npwp,x.email,x.department,x.position,x.ptkp,x.ter_category,x.hire_date,x.bank_name,x.bank_number,x.name,x.health_no,x.employment_no,x.basic_salary,x.fixed_allowance,MIN(u.id)
      FROM companies c JOIN users u ON u.company_id=c.id CROSS JOIN (
        SELECT 'EMP-001' employee_number,'Andi Pratama' name,'3173000000000001' nik,'1234567890123456' npwp,'andi@demo.co.id' email,'Keuangan' department,'Accounting Supervisor' position,'K/1' ptkp,'B' ter_category,'2022-03-01' hire_date,'BCA' bank_name,'1234567890' bank_number,'00012026001' health_no,'210000001' employment_no,12000000 basic_salary,1500000 fixed_allowance
        UNION ALL SELECT 'EMP-002','Siti Rahma','3173000000000002','2234567890123456','siti@demo.co.id','Penjualan','Account Executive','TK/0','A','2023-01-09','Mandiri','1300012345678','00012026002','210000002',8500000,1000000
        UNION ALL SELECT 'EMP-003','Budi Santoso','3173000000000003','3234567890123456','budi@demo.co.id','Operasional','Warehouse Officer','K/0','A','2024-02-12','BNI','9876543210','00012026003','210000003',6500000,750000
      ) x GROUP BY c.id,x.employee_number,x.name,x.nik,x.npwp,x.email,x.department,x.position,x.ptkp,x.ter_category,x.hire_date,x.bank_name,x.bank_number,x.health_no,x.employment_no,x.basic_salary,x.fixed_allowance`)
  },
  async down(db: MigrationDatabase) {
    await db.query(`DELETE rp FROM role_permissions rp INNER JOIN permissions p ON p.id=rp.permission_id WHERE p.module='payroll'`)
    await db.query(`DELETE FROM permissions WHERE module='payroll'`)
    await dropTables(db, ['payroll_entries','payroll_runs','payroll_employees','payroll_ter_rates','payroll_policies'])
  },
}
