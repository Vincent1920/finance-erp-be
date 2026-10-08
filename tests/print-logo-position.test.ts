import { test, expect } from 'bun:test'
import { printTemplateSchema } from '../validators/operations.validator'

const template = { documentType: 'sales_invoice', fontSize: 11, pageSize: 'A4', orientation: 'portrait', marginMm: 14, showCompany: true, showReference: true, showNotes: true, showTax: true, showSignature: true, accentColor: '#2563eb', footer: '', logoPlacement: 'free', logoXmm: 150, logoYmm: 5, logoWidthMm: 25, logoHeightMm: 20 }
test('free logo positioning persists coordinates within printable paper area', () => {
  const result = printTemplateSchema.parse(template)
  expect(result.logoXmm).toBe(150)
  expect(result.logoWidthMm).toBe(25)
})
test('logo outside paper margins is rejected for portrait and smaller paper', () => {
  expect(printTemplateSchema.safeParse({ ...template, logoXmm: 170 }).success).toBe(false)
  expect(printTemplateSchema.safeParse({ ...template, pageSize: 'A5' }).success).toBe(false)
  expect(printTemplateSchema.safeParse({ ...template, logoYmm: 260 }).success).toBe(false)
})
test('landscape uses swapped page dimensions and existing inline templates stay compatible', () => {
  expect(printTemplateSchema.safeParse({ ...template, orientation: 'landscape', logoXmm: 230 }).success).toBe(true)
  expect(printTemplateSchema.parse({ ...template, logoPlacement: undefined }).logoPlacement).toBe('inline')
})
