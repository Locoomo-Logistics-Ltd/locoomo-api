import { AppException } from './app.exception';
import { BusinessException } from './business.exception';
import { EntityNotFoundException } from './entity-not-found.exception';

describe('EntityNotFoundException', () => {
  it('carries a stable error code and 404 status', () => {
    const err = new EntityNotFoundException('Order', 'abc-123');

    expect(err.errorCode).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
    expect(err.message).toBe('Order with id abc-123 was not found');
    expect(err.context).toEqual({ entity: 'Order', id: 'abc-123' });
  });

  it('is an instance of its full category chain', () => {
    const err = new EntityNotFoundException('Node', 42);

    expect(err).toBeInstanceOf(EntityNotFoundException);
    expect(err).toBeInstanceOf(BusinessException);
    expect(err).toBeInstanceOf(AppException);
    expect(err).toBeInstanceOf(Error);
  });

  it('sets name to the concrete class name, not the abstract base', () => {
    const err = new EntityNotFoundException('Rider', 1);

    expect(err.name).toBe('EntityNotFoundException');
  });
});
