import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceError,
  UnauthorizedError,
  ValidationError,
} from '../src/middleware/errors.js';

describe('domain error classes', () => {
  it('maps each subclass to its HTTP status code', () => {
    expect(new UnauthorizedError().statusCode).toBe(401);
    expect(new ForbiddenError().statusCode).toBe(403);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new ConflictError().statusCode).toBe(409);
    expect(new ValidationError().statusCode).toBe(422);
  });

  it('lets AppError carry a caller-supplied status code', () => {
    const err = new AppError('Teapot', 418);
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe('Teapot');
  });

  it('makes every subclass an instance of ServiceError and Error', () => {
    const errors = [
      new UnauthorizedError(),
      new ForbiddenError(),
      new NotFoundError(),
      new ConflictError(),
      new ValidationError(),
      new AppError('boom', 500),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('sets the error name to the concrete subclass name', () => {
    expect(new UnauthorizedError().name).toBe('UnauthorizedError');
    expect(new ForbiddenError().name).toBe('ForbiddenError');
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new ConflictError().name).toBe('ConflictError');
    expect(new ValidationError().name).toBe('ValidationError');
    expect(new AppError('x', 500).name).toBe('AppError');
  });

  it('applies sensible default messages and accepts overrides', () => {
    expect(new UnauthorizedError().message).toBe('Unauthorized');
    expect(new ForbiddenError().message).toBe('Forbidden');
    expect(new NotFoundError().message).toBe('Not found');
    expect(new ConflictError().message).toBe('Conflict');
    expect(new ValidationError().message).toBe('Validation failed');
    expect(new NotFoundError('Channel not found').message).toBe('Channel not found');
  });

  it('passes through field-level details on ValidationError', () => {
    const details = { email: ['Invalid email'], password: ['Too short'] };
    const err = new ValidationError('Invalid request body', details);
    expect(err.details).toEqual(details);
    expect(err.statusCode).toBe(422);
  });

  it('leaves ValidationError.details undefined when omitted', () => {
    expect(new ValidationError().details).toBeUndefined();
  });
});
