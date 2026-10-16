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
import { OnlineActionError } from "./errors";
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
) {
  const service = useMemo(
    () => (repository ? new OnlinePlayerService(repository, identity) : null),
    [repository, identity],
  );
  const [state, setState] = useState<LoadState>(empty);
  const [action, setAction] = useState<"create" | "join" | "move" | null>(null);
  const [pendingPromotion, setPendingPromotion] =
    useState<PendingPromotion | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const id = ++generation.current;
    operation.current?.abort();
    busy.current = false;
    setAction(null);
    setPendingPromotion(null);
    const controller = new AbortController();
    if (!service)
      setState({ ...empty, phase: "error", error: onlineConfigurationMessage });
    else if (!gameId) setState(empty);
    else {
      setState((previous) => ({ ...previous, phase: "loading", error: "" }));
      service
        .loadGame(gameId, controller.signal)
        .then((session) => {
          if (!controller.signal.aborted && generation.current === id)
            setState(loaded(session));
        })
        .catch((error) => {
          if (!controller.signal.aborted && generation.current === id)
            setState({ ...empty, phase: "error", error: message(error) });
        });
    }
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [service, gameId, refresh]);

  async function perform(
    kind: "create" | "join" | "move",
    run: (
      service: OnlinePlayerService,
      signal: AbortSignal,
    ) => Promise<OnlinePlayerSession>,
  ) {
    if (!service || busy.current) return;
    busy.current = true;
    const id = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    const current = () =>
      generation.current === id && !controller.signal.aborted;
    setAction(kind);
    setState((previous) => ({ ...previous, error: "" }));
    try {
      const session = await run(service, controller.signal);
      if (current()) {
        setPendingPromotion(null);
        if (kind === "create") onCreated(session.game.id);
        else setState(loaded(session));
      }
    } catch (error) {
      if (!current()) return;
      const text = message(error);
      // A failed response may hide an already committed move. Reload once; never
      // automatically retry a mutation. Conflicts also require a fresh snapshot.
      if (kind === "move" && gameId) {
        setPendingPromotion(null);
        try {
          const session = await service.loadGame(gameId, controller.signal);
          if (current()) setState(loaded(session, text));
        } catch {
          if (current())
            setState((previous) => ({
              ...previous,
              phase: "error",
              error: `${text} Не удалось обновить состояние. Нажмите «Обновить позицию».`,
            }));
        }
      } else setState((previous) => ({ ...previous, error: text }));
    } finally {
      if (current()) {
        busy.current = false;
        setAction(null);
      }
    }
  }
  const game =
    state.game?.id.toLowerCase() === gameId?.toLowerCase() ? state.game : null;
  const canMove =
    !!game &&
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
    canMove,
    pendingPromotion,
    promote,
    cancelPromotion: () => setPendingPromotion(null),
    requestMove,
    creating: action === "create",
    createGame: (choice: CreatorColorChoice) =>
      perform("create", (service, signal) =>
        service.createGame(choice, signal),
      ),
    joinGame: () =>
      gameId
        ? perform("join", (service, signal) => service.joinGame(gameId, signal))
        : Promise.resolve(),
    reload: () => {
      if (!busy.current) setRefresh((value) => value + 1);
    },
  };
}
