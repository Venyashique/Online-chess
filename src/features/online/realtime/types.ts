export type OnlineConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';
export type VersionSignal = { gameId: string; version: number };
export type RealtimeHandlers = {
  onVersion(signal: VersionSignal): void;
  onStatus(status: OnlineConnectionStatus): void;
};
export interface OnlineRealtimeSubscription {
  unsubscribe(): void;
  reconnect(): void;
}
export interface OnlineRealtimeClient {
  subscribe(gameId: string, handlers: RealtimeHandlers): OnlineRealtimeSubscription;
}
