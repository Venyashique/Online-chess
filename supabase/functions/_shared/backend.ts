import type { Operation } from './limiter.ts';
import type { MoveCommand } from '../submit-online-move/handler.ts';
type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export function createOnlineBackend(client: RpcClient) {
  const call = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error('Backend unavailable'); // Never forward/log body or credentials.
    return data;
  };
  return {
    admit: (operation: Operation, id: string, token: string | null) => call('online_api_admit', { p_operation: operation, p_id: id, p_token: token }),
    reserveTurnstile: (hash: string, id: string, token: string) => call('online_api_reserve_turnstile', { p_hash: hash, p_id: id, p_token: token }),
    create: (id: string, choice: string, token: string, reservation: string, challengeTs: string) => call('online_api_create_reserved', { p_id: id, p_color_choice: choice, p_token: token, p_reservation: reservation, p_challenge_ts: challengeTs }),
    join: (id: string, token: string) => call('online_api_join', { p_id: id, p_token: token }),
    commitMove: (c: MoveCommand) => call('online_api_commit_move', { p_id: c.gameId, p_token: c.token, p_expected_version: c.expectedVersion, p_from: c.from, p_to: c.to, p_promotion: c.promotion ?? null }),
  };
}
