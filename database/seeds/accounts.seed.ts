import type { SeedConnection } from './types'
const accounts = [
  ['1000', 'Assets', 'asset', 'debit'],
  ['1100', 'Current Assets', 'asset', 'debit'],
  ['1110', 'Cash', 'asset', 'debit'],
  ['1120', 'Bank', 'asset', 'debit'],
  ['1130', 'Accounts Receivable', 'asset', 'debit'],
  ['1140', 'Inventory', 'asset', 'debit'],
  ['1200', 'Fixed Assets', 'asset', 'debit'],
  ['1210', 'Accumulated Depreciation', 'asset', 'credit'],
  ['2000', 'Liabilities', 'liability', 'credit'],
  ['2100', 'Accounts Payable', 'liability', 'credit'],
  ['2200', 'Tax Payable', 'liability', 'credit'],
  ['3000', 'Equity', 'equity', 'credit'],
  ['3100', 'Capital', 'equity', 'credit'],
  ['3200', 'Retained Earnings', 'equity', 'credit'],
  ['3300', 'Current Year Earnings', 'equity', 'credit'],
  ['4000', 'Revenue', 'revenue', 'credit'],
  ['4100', 'Sales Revenue', 'revenue', 'credit'],
  ['4200', 'Other Revenue', 'other_income', 'credit'],
  ['5000', 'Cost of Goods Sold', 'cogs', 'debit'],
  ['5100', 'Cost of Goods Sold', 'cogs', 'debit'],
  ['6000', 'Operating Expenses', 'expense', 'debit'],
  ['6100', 'Salary Expense', 'expense', 'debit'],
  ['6200', 'Rent Expense', 'expense', 'debit'],
  ['6300', 'Electricity Expense', 'expense', 'debit'],
  ['6400', 'Depreciation Expense', 'expense', 'debit'],
  ['6500', 'Office Expense', 'expense', 'debit'],
] as const
export async function seedAccounts(connection: SeedConnection) {
  for (const [code, name, type, normal] of accounts)
    await connection.execute(
      'INSERT IGNORE INTO accounts(company_id,code,name,account_type,normal_balance,is_header,is_posting) VALUES(1,?,?,?,?,?,?)',
      [code, name, type, normal, code.endsWith('00'), !code.endsWith('00')],
    )
}
