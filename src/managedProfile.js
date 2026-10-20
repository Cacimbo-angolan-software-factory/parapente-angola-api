// node-postgres encodes JS arrays as PostgreSQL array literals, not JSON arrays.
// Encode JSONB explicitly while preserving SQL NULL and scalar column values.
export function managedProfileValues(id, profile) {
  return [id, ...Object.entries(profile).map(([field, value]) => (
    field === 'level_history' && value !== null && value !== undefined
      ? JSON.stringify(value)
      : value
  ))];
}
