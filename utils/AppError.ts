export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly errors?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', errors?: unknown) {
    super(message, 422, errors)
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Data tidak ditemukan') {
    super(message, 404)
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Data conflict', errors?: unknown) {
    super(message, 409, errors)
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401)
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Anda tidak memiliki hak akses') {
    super(message, 403)
  }
}
