import { ValueTransformer } from 'typeorm';

// Postgres numeric comes back from the driver as a string (to avoid float
// precision loss); for small decimal quantities like a parcel's weight a JS
// number is what we want. Raw queries bypass this — Number() their result.
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
