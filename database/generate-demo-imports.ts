import ExcelJS from 'exceljs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = join(dirname(fileURLToPath(import.meta.url)), 'demo-imports')
for (const file of await readdir(directory)) {
  if (!file.endsWith('.csv')) continue
  const rows = (await readFile(join(directory, file), 'utf8'))
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.split(','))
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Demo Import')
  sheet.addRows(rows)
  sheet.getRow(1).font = { bold: true }
  sheet.columns.forEach((column) => {
    column.width = 22
  })
  await workbook.xlsx.writeFile(join(directory, file.replace(/\.csv$/, '.xlsx')))
}
