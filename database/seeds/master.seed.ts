import type { SeedConnection } from './types'
export async function seedMaster(connection: SeedConnection) {
  for (const [code, name, symbol] of [
    ['PCS', 'Pieces', 'pcs'],
    ['BOX', 'Box', 'box'],
    ['KG', 'Kilogram', 'kg'],
  ])
    await connection.execute(
      'INSERT IGNORE INTO units(company_id,code,name,symbol) VALUES(1,?,?,?)',
      [code, name, symbol],
    )
  for (const [code, name] of [
    ['MAIN', 'Gudang Utama'],
    ['JKT', 'Gudang Jakarta'],
    ['SBY', 'Gudang Surabaya'],
  ])
    await connection.execute('INSERT IGNORE INTO warehouses(company_id,code,name) VALUES(1,?,?)', [
      code,
      name,
    ])
  for (const [code, name, type, rate] of [
    ['PPN11', 'PPN 11%', 'vat', 11],
    ['PPN12', 'PPN 12%', 'vat', 12],
    ['NONPPN', 'Non PPN', 'other', 0],
  ])
    await connection.execute(
      'INSERT IGNORE INTO tax_codes(company_id,code,name,tax_type,rate) VALUES(1,?,?,?,?)',
      [code, name, type, rate],
    )
  for (const [code, name] of [
    ['HO', 'Head Office'],
    ['SALES', 'Sales'],
    ['OPS', 'Operations'],
  ])
    await connection.execute(
      'INSERT IGNORE INTO cost_centers(company_id,code,name) VALUES(1,?,?)',
      [code, name],
    )
}
