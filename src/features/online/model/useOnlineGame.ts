import { useEffect, useMemo, useRef, useState } from "react";
import { OnlineGameService } from "./OnlineGameService";
import type {
  CreatorColorChoice,
  OnlineGame,
  OnlineGameRepository,
} from "./types";

type LoadState = {
  phase: "idle" | "loading" | "ready" | "error";
  game: OnlineGame | null;
  error: string;
};
export const onlineConfigurationMessage =
  "Онлайн-режим пока не настроен. Укажите VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY в .env.local, затем перезапустите приложение.";
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Не удалось загрузить партию. Повторите попытку.";

export function useOnlineGame(
  repository: OnlineGameRepository | null,
  gameId: string | undefined,
  onCreated: (id: string) => void,
) {
  const service = useMemo(
    () => (repository ? new OnlineGameService(repository) : null),
    [repository],
  );
  const [state, setState] = useState<LoadState>({
    phase: "idle",
    game: null,
    error: "",
  });
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const generation = useRef(0);
  const creation = useRef<AbortController | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(
    () => () => {
      generation.current++;
      creation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const id = ++generation.current;
    creation.current?.abort();
    creatingRef.current = false;
    setCreating(false);
    const controller = new AbortController();
    if (!service)
      setState({
        phase: "error",
        game: null,
        error: onlineConfigurationMessage,
      });
    else if (!gameId) setState({ phase: "idle", game: null, error: "" });
    else {
      setState({ phase: "loading", game: null, error: "" });
      service
        .loadGame(gameId, controller.signal)
        .then((game) => {
          if (!controller.signal.aborted && generation.current === id)
            setState({ phase: "ready", game, error: "" });
        })
        .catch((error) => {
          if (!controller.signal.aborted && generation.current === id)
            setState({ phase: "error", game: null, error: message(error) });
        });
    }
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [service, gameId, refresh]);

  async function createGame(choice: CreatorColorChoice) {
    if (!service || creatingRef.current) return;
    creatingRef.current = true;
    const id = ++generation.current;
    const controller = new AbortController();
    creation.current = controller;
    setCreating(true);
    setState({ phase: "idle", game: null, error: "" });
    try {
      const game = await service.createGame(choice, controller.signal);
      if (!controller.signal.aborted && generation.current === id)
        onCreated(game.id);
    } catch (error) {
      if (!controller.signal.aborted && generation.current === id)
        setState({ phase: "error", game: null, error: message(error) });
    } finally {
      if (generation.current === id) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  }

  return {
    ...state,
    game:
      state.game?.id.toLowerCase() === gameId?.toLowerCase()
        ? state.game
        : null,
    creating,
    createGame,
    reload: () => setRefresh((value) => value + 1),
  };
}
