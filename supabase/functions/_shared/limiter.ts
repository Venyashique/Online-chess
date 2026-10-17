import { object } from './http.ts';
export type Operation = 'create' | 'join' | 'read' | 'move';
export interface LimitedBackend { admit(operation: Operation, id: string, token: string | null): Promise<unknown>; }
export type Admission = { code: string; retry_after?: number; session?: unknown; existing_session?: unknown };
/** No in-memory authority, client-selected keys, IP headers or permissive fallback. */
export async function admit(backend: LimitedBackend, operation: Operation, id: string, token: string | null): Promise<Admission> {
  const result = object(await backend.admit(operation, id, token));
  if (!result || typeof result.code !== 'string' || !['OK','NOT_FOUND','GAME_EXISTS','GAME_EXPIRED','INVALID_TOKEN','INVALID_REQUEST','RATE_LIMITED'].includes(result.code)) throw new Error('Admission unavailable');
  if (result.code === 'RATE_LIMITED' && (!Number.isInteger(result.retry_after) || Number(result.retry_after) < 1 || Number(result.retry_after) > 86400)) throw new Error('Invalid admission');
  if (result.code === 'OK') {
    if (result.existing_session !== undefined) {
      if (!['create', 'join'].includes(operation) || !object(result.existing_session)) throw new Error('Invalid admission');
    } else if (operation !== 'create' && !object(result.session)) throw new Error('Invalid admission');
    else if (operation === 'create' && result.session !== undefined) throw new Error('Invalid admission');
  }
  return result as Admission;
}
