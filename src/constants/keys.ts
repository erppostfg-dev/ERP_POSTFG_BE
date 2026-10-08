/**
 * { A: ..., B: ... } -> { A: 'A', B: 'B' }: the keys of a definitions object as constants, so code can write
 * ERROR_CODES.NO_SENDER instead of the string 'NO_SENDER'.
 */
export const keysOf = <T extends object>(definitions: T): { readonly [K in keyof T]: K } =>
  Object.fromEntries(Object.keys(definitions).map((k) => [k, k])) as { readonly [K in keyof T]: K };
