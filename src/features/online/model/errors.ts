const messages: Record<string, string> = {
  NOT_FOUND: "Партия не найдена.",
  GAME_FULL: "Оба места уже заняты. Вы можете просматривать партию.",
  LEGACY_READ_ONLY:
    "Эта партия создана до появления мест игроков и доступна только для просмотра. Создайте новую партию.",
  INVALID_TOKEN:
    "Ключ игрока недействителен или потерян. Право на занятое место без ключа восстановить нельзя.",
  NOT_READY: "Ожидаем второго игрока.",
  NOT_YOUR_TURN: "Сейчас очередь соперника.",
  VERSION_CONFLICT:
    "Позиция изменилась. Загружено актуальное состояние; выберите ход заново.",
  GAME_OVER: "Партия уже завершена.",
  INVALID_MOVE: "Недопустимый шахматный ход.",
  GAME_EXISTS: "Не удалось создать новую партию. Повторите создание.",
  UNAVAILABLE:
    "Не удалось подтвердить ход. Проверьте подключение и обновите партию.",
};
export class OnlineActionError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? messages.UNAVAILABLE);
  }
}
