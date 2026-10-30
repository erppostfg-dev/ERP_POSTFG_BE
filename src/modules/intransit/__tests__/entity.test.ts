import { describe, expect, it } from 'vitest';
import { entityOf } from '../stages/entity';

describe('entityOf', () => {
  it('is Kreative when the SKU code has HYP anywhere, in any case', () => {
    expect(entityOf('HYPMUBX001F050')).toBe('Kreative');
    expect(entityOf('HYPN12345678')).toBe('Kreative');
    expect(entityOf('cmb-hyp-kit')).toBe('Kreative');
  });

  it('is Pep otherwise', () => {
    expect(entityOf('MCAF-CF-100')).toBe('Pep');
    expect(entityOf('')).toBe('Pep');
  });
});
