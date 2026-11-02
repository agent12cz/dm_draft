export type TurnCountdown = {
  turnKey: string;
  seconds: number;
};

export function getTurnKey(
  draftId: string,
  currentPickIndex: number,
  turnStartedAtMs: number | null,
) {
  return `${draftId}-${currentPickIndex}-${turnStartedAtMs ?? ""}`;
}

export function getTimeLeftForTurn(
  countdown: TurnCountdown | null,
  turnKey: string | null,
) {
  return turnKey !== null && countdown?.turnKey === turnKey ? countdown.seconds : null;
}
