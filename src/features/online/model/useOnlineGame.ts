import { OnlineGameSync } from "../realtime/OnlineGameSync";
import type { OnlineConnectionStatus, OnlineRealtimeClient, OnlineRealtimeSubscription } from "../realtime/types";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Color,
  MoveAction,
  Promotion,
} from "../../../shared/chess/domain/types";
import { browserPlayerIdentity } from "../identity/PlayerIdentityStore";
import type { PlayerIdentity } from "../identity/PlayerIdentityStore";
import { OnlinePlayerService } from "./OnlinePlayerService";
import type { OnlinePlayerSession } from "./OnlinePlayerService";
import { OnlineActionError, retryDelay } from "./errors";
import type {
  CreatorColorChoice,
  OnlineGame,
  OnlinePlayerRepository,
} from "./types";

type LoadState = {
  phase: "idle" | "loading" | "ready" | "error";
  game: OnlineGame | null;
  playerColor: Color | null;
  identityNotice: string;
  error: string;
};
const empty: LoadState = {
  phase: "idle",
  game: null,
  playerColor: null,
  identityNotice: "",
  error: "",
};
export const onlineConfigurationMessage =
  "Онлайн-режим пока не настроен. Укажите VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env.local, затем перезапустите приложение.";
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Не удалось загрузить партию. Повторите попытку.";
const loaded = (session: OnlinePlayerSession, error = ""): LoadState => ({
  phase: "ready",
  game: session.game,
  playerColor: session.playerColor,
  identityNotice: session.identityNotice,
  error,
});
type PendingPromotion = {
  from: MoveAction["from"];
  to: MoveAction["to"];
  choices: Promotion[];
};

export function useOnlineGame(
  repository: OnlinePlayerRepository | null,
  gameId: string | undefined,
  onCreated: (id: string) => void,
  identity: PlayerIdentity = browserPlayerIdentity,
  realtime: OnlineRealtimeClient | null = null,
) {
  const service = useMemo(
    () => (repository ? new OnlinePlayerService(repository, identity) : null),
    [repository, identity],
  );
  const [state, setState] = useState<LoadState>(empty);
  const [action, setAction] = useState<"create" | "join" | "move" | null>(null);
  const [pendingPromotion, setPendingPromotion] =
    useState<PendingPromotion | null>(null);
  const [retryUntil, setRetryUntil] = useState(0);
  const cooldown = retryUntil > Date.now();
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setTimeout(() => setRetryUntil(0), Math.max(0, retryUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [retryUntil]);
  const busy = useRef(false);
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const sync = useRef<OnlineGameSync | null>(null);
  const lastSession = useRef<OnlinePlayerSession | null>(null);
  const mutationNotice = useRef("");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [connection, setConnection] = useState<OnlineConnectionStatus>("connecting");

  useEffect(() => {
    const id = ++generation.current;
    operation.current?.abort(); busy.current = false;
    setAction(null); setPendingPromotion(null); lastSession.current = null;
    setRetryUntil(0); mutationNotice.current = ""; setSyncError(""); setSyncing(false);
    const current = () => generation.current === id;
    if (!service || !gameId) {
      sync.current = null;
      setState(!service ? { ...empty, phase: "error", error: onlineConfigurationMessage } : empty);
      setConnection("offline");
      return () => { generation.current++; operation.current?.abort(); };
    }
    setState({ ...empty, phase: "loading" });
    setConnection(realtime ? "connecting" : "offline");
    const coordinator = new OnlineGameSync(signal => service.loadGame(gameId, signal), {
      onSession(session) {
        if (!current()) return;
        const previous = lastSession.current;
        lastSession.current = session;
        setSyncError("");
        if (previous && previous.game.version === session.game.version && previous.playerColor === session.playerColor && previous.identity === session.identity && previous.identityNotice === session.identityNotice) {
          setState(state => ({ ...state, phase: "ready", error: mutationNotice.current }));
        } else {
          setPendingPromotion(null);
          setState(loaded(session, mutationNotice.current));
        }
      },
      onLoading(loading) {
        if (!current()) return;
        setSyncing(loading);
        if (loading && !lastSession.current) setState(previous => ({ ...previous, phase: "loading", error: "" }));
      },
      onError(error) {
        if (!current()) return;
        if (!lastSession.current) setState({ ...empty, phase: "error", error: message(error) });
        else setSyncError(retryDelay(error) ? message(error) : "Не удалось обновить позицию. Можно повторить вручную.");
      },
    });
    sync.current = coordinator;
    let subscription: OnlineRealtimeSubscription | null = null;
    try {
      subscription = realtime?.subscribe(gameId, {
        onVersion(signal) { if (current() && signal.gameId.toLowerCase() === gameId.toLowerCase()) coordinator.hint(signal.version); },
        onStatus(status) {
          if (!current()) return;
          setConnection(status);
          // Every SUBSCRIBED, including the first, closes the load/subscribe gap.
          if (status === "online") coordinator.request();
        },
      }) ?? null;
    } catch { setConnection("offline"); }
    coordinator.request();
    const onOnline = () => { if (current()) { subscription?.reconnect(); coordinator.request(); } };
    const onOffline = () => { if (current()) setConnection("offline"); };
    const onVisible = () => {
      if (current() && document.visibilityState === "visible") {
        if (navigator.onLine) subscription?.reconnect();
        coordinator.request();
      }
    };
    window.addEventListener("online", onOnline); window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    // Reconcile missed best-effort signals, even if a socket appeared healthy.
    const safety = setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine) coordinator.request(); }, 30000);
    return () => {
      generation.current++; operation.current?.abort(); coordinator.dispose();
      subscription?.unsubscribe(); clearInterval(safety);
      window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      if (sync.current === coordinator) sync.current = null;
    };
  }, [service, gameId, realtime]);

  async function perform(
    kind: "create" | "join" | "move",
    run: (
      service: OnlinePlayerService,
      signal: AbortSignal,
    ) => Promise<OnlinePlayerSession>,
  ) {
    if (!service || busy.current || retryUntil > Date.now()) return;
    busy.current = true;
    const id = generation.current;
    const coordinator = sync.current;
    coordinator?.pause();
    const controller = new AbortController();
    operation.current = controller;
    const current = () =>
      generation.current === id && !controller.signal.aborted;
    mutationNotice.current = "";
    setAction(kind);
    setState((previous) => ({ ...previous, error: "" }));
    try {
      const session = await run(service, controller.signal);
      if (current()) {
        setPendingPromotion(null);
        if (kind === "create") onCreated(session.game.id);
        else coordinator?.confirm(session);
      }
    } catch (error) {
      if (!current()) return;
      const seconds = retryDelay(error);
      if (seconds) { setRetryUntil(Date.now() + seconds * 1000); coordinator?.deferRetry(seconds); }
      const text = message(error);
      mutationNotice.current = text;
      setState(previous => ({ ...previous, error: text }));
      if (kind === "move") {
        setPendingPromotion(null);
        // Re-read once: the mutation may have committed despite a lost response.
        // Never replay a mutation from a Broadcast or a reconnect.
        coordinator?.request(true);
      }

    } finally {
      if (current()) {
        busy.current = false;
        setAction(null);
        coordinator?.resume();
      }
    }
  }
  const game =
    state.game?.id.toLowerCase() === gameId?.toLowerCase() ? state.game : null;
  const canMove =
    !!game &&
    !cooldown &&
    !!state.playerColor &&
    !!game.seats?.opponentJoinedAt &&
    !game.seats.legacy &&
    state.phase === "ready" &&
    !action &&
    !game.position.result &&
    game.position.turn === state.playerColor;
  function requestMove(move: MoveAction) {
    if (!canMove || !game || pendingPromotion || busy.current) return;
    const choices = game.position.legalMoves.filter(
      (m) => m.from === move.from && m.to === move.to,
    );
    if (!choices.length) {
      setState((previous) => ({
        ...previous,
        error: new OnlineActionError("INVALID_MOVE").message,
      }));
      return;
    }
    const promotions = choices.flatMap((m) =>
      m.promotion ? [m.promotion] : [],
    );
    if (promotions.length && !move.promotion) {
      setPendingPromotion({
        from: move.from,
        to: move.to,
        choices: promotions,
      });
      return;
    }
    void perform("move", (service, signal) =>
      service.submitMove(game.id, move, game.version, signal),
    );
  }
  function promote(promotion: Promotion) {
    if (
      !pendingPromotion ||
      !game ||
      !canMove ||
      !pendingPromotion.choices.includes(promotion)
    )
      return;
    const move = {
      from: pendingPromotion.from,
      to: pendingPromotion.to,
      promotion,
    };
    setPendingPromotion(null);
    void perform("move", (service, signal) =>
      service.submitMove(game.id, move, game.version, signal),
    );
  }
  return {
    ...state,
    game,
    action,
    syncing, syncError, cooldown, connection: syncError ? "offline" as const : connection,
    canMove,
    pendingPromotion,
    promote,
    cancelPromotion: () => setPendingPromotion(null),
    requestMove,
    creating: action === "create",
    createGame: (choice: CreatorColorChoice, turnstileToken?: string) =>
      perform("create", (service, signal) =>
        service.createGame(choice, signal, turnstileToken),
      ),
    joinGame: () =>
      gameId
        ? perform("join", (service, signal) => service.joinGame(gameId, signal))
        : Promise.resolve(),
    reload: () => {
      if (!busy.current) { mutationNotice.current = ""; setState(previous => ({ ...previous, error: "" })); sync.current?.request(true); }
    },
  };
}
