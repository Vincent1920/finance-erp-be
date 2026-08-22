export const JOURNAL_STATUS = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  POSTED: 'posted',
  REVERSED: 'reversed',
  CANCELLED: 'cancelled',
} as const
export const PERIOD_STATUS = { OPEN: 'open', SOFT_CLOSED: 'soft_closed', CLOSED: 'closed' } as const
export const MONEY_TOLERANCE = 0.005
