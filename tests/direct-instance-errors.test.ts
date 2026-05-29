import Limrun from '@limrun/api';
import { directInstanceHttpError } from '@limrun/api/internal/direct-instance-errors';

describe('directInstanceHttpError', () => {
  test('maps direct instance 404 responses to NotFoundError', () => {
    const err = directInstanceHttpError('folder-sync http', 404, '404 page not found', new Headers());

    expect(err).toBeInstanceOf(Limrun.NotFoundError);
    expect(err.message).toContain('folder-sync http failed: 404 404 page not found');
  });

  test('leaves non-404 direct instance responses as generic operation errors', () => {
    const err = directInstanceHttpError('POST /simulator', 500, 'boom', new Headers());

    expect(err).not.toBeInstanceOf(Limrun.NotFoundError);
    expect(err.message).toBe('POST /simulator failed: 500 boom');
  });
});
