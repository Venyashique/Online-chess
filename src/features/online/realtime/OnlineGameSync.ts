import { retryDelay } from '../model/errors';
import type { OnlinePlayerSession } from '../model/OnlinePlayerService';

export type SyncCallbacks = {
  onSession(session: OnlinePlayerSession): void;
  onLoading(loading: boolean): void;
  onError(error: unknown): void;
};
/** One read at a time. The only version watermark comes from confirmed RPC or
 * mutation responses, never from untrusted Broadcast hints. */
export class OnlineGameSync {
  private confirmed = 0;
  private retryNotBefore = 0;
  private paused = false;
  private disposed = false;
  private force = false;
  private urgent = false;
  private active: AbortController | null = null;
  private sequence = 0;
  private lastStarted = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seenHints = new Set<number>();
  private pendingHints = new Set<number>();

  constructor(private readonly load: (signal: AbortSignal) => Promise<OnlinePlayerSession>, private readonly callbacks: SyncCallbacks, private readonly minIntervalMs = 1000) {}

  hint(version: number) {
    if (this.disposed || !Number.isSafeInteger(version) || version <= this.confirmed || this.seenHints.has(version)) return;
    this.seenHints.add(version); this.pendingHints.add(version);
    if (this.pendingHints.size > 64) this.pendingHints.delete(this.pendingHints.values().next().value!);
    if (this.seenHints.size > 64) this.seenHints.delete(this.seenHints.values().next().value!);
    this.drain();
  }
  request(immediate = false) {
    if (this.disposed) return;
    this.force = true; this.urgent ||= immediate;
    if (immediate && this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.drain();
  }
  deferRetry(seconds: number) {
    if (this.disposed) return;
    this.retryNotBefore = Math.max(this.retryNotBefore, Date.now() + Math.min(86400, Math.max(1, seconds)) * 1000);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  confirm(session: OnlinePlayerSession): boolean {
    if (this.disposed || session.game.version < this.confirmed) return false;
    this.confirmed = session.game.version;
    for (const version of this.seenHints) if (version <= this.confirmed) this.seenHints.delete(version);
    for (const version of this.pendingHints) if (version <= this.confirmed) this.pendingHints.delete(version);
    this.callbacks.onSession(session);
    return true;
  }
  pause() {
    this.paused = true;
    if (this.active) { this.force = true; this.sequence++; this.active.abort(); this.active = null; this.callbacks.onLoading(false); }
  }
  resume() { this.paused = false; this.drain(); }
  dispose() {
    this.disposed = true; this.sequence++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.active?.abort(); this.active = null;
  }
  private drain() {
    if (this.disposed || this.paused || this.active || (!this.force && !this.pendingHints.size) || this.timer) return;
    const delay = Math.max(0, this.retryNotBefore - Date.now(), this.urgent ? 0 : this.lastStarted + this.minIntervalMs - Date.now());
    if (delay) { this.timer = setTimeout(() => { this.timer = null; this.drain(); }, delay); return; }
    this.force = false; this.urgent = false; this.pendingHints.clear(); this.lastStarted = Date.now();
    const controller = new AbortController(); this.active = controller;
    const sequence = ++this.sequence;
    const current = () => !this.disposed && !controller.signal.aborted && sequence === this.sequence;
    this.callbacks.onLoading(true);
    let request: Promise<OnlinePlayerSession>;
    try { request = this.load(controller.signal); } catch (error) { request = Promise.reject(error); }
    request.then(session => {
      if (current()) this.confirm(session);
    }).catch(error => { if (current()) { const seconds = retryDelay(error); if (seconds) { this.deferRetry(seconds); this.force = true; } this.callbacks.onError(error); } }).finally(() => {
      if (!current()) return;
      this.active = null; this.callbacks.onLoading(false); this.drain();
    });
  }
}
