export const seatStorageKey = (id: string) =>
  `online-chess:seat:${id.toLowerCase()}`;
export const validSeatToken = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export type StoredIdentity = {
  token: string | null;
  state: "available" | "missing" | "invalid" | "unavailable";
};
export interface PlayerIdentity {
  read(id: string): StoredIdentity;
  ensure(id: string): string;
  clear(id: string): void;
}
export function generateSeatToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bearer credentials never enter URLs, UI strings, telemetry or shared records. */
export class PlayerIdentityStore implements PlayerIdentity {
  constructor(
    private readonly storage: () => Storage = () => window.localStorage,
  ) {}
  read(id: string): StoredIdentity {
    try {
      const token = this.storage().getItem(seatStorageKey(id));
      if (token === null) return { token: null, state: "missing" };
      if (!validSeatToken(token)) {
        this.clear(id);
        return { token: null, state: "invalid" };
      }
      return { token, state: "available" };
    } catch {
      return { token: null, state: "unavailable" };
    }
  }
  ensure(id: string): string {
    const old = this.read(id);
    if (old.token) return old.token;
    const token = generateSeatToken();
    try {
      this.storage().setItem(seatStorageKey(id), token);
    } catch {
      throw new Error(
        "Хранилище браузера недоступно. Разрешите локальное хранение, чтобы сохранить своё место.",
      );
    }
    return token;
  }
  clear(id: string) {
    try {
      this.storage().removeItem(seatStorageKey(id));
    } catch {
      /* Read-only viewing is still possible. */
    }
  }
}
export const browserPlayerIdentity = new PlayerIdentityStore();
