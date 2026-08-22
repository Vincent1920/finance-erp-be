export const pagination = (pageValue?: string, limitValue?: string) => {
  const page = Math.max(1, Number(pageValue) || 1),
    limit = Math.min(100, Math.max(1, Number(limitValue) || 20))
  return { page, limit, offset: (page - 1) * limit }
}
