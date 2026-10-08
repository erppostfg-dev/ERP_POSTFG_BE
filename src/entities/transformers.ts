import { ValueTransformer } from 'typeorm';

/**
 * DECIMAL columns: MySQL returns them as strings (to keep precision); the app works with numbers.
 * null stays null. Amounts here have at most 4 decimals, well inside a JavaScript number's precision.
 */
export const decimal: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null || value === undefined ? null : Number(value)),
};
