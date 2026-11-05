import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { zNum, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Sibau Wars: "Focus" — a player throws troops at an enemy tank that is in
 * or next to their land. Every `focusTroopsPerHealth` troops knock off one
 * point of the tank's health; troops beyond what the kill needs are kept.
 */
export class FocusTankExecution implements Execution {
  private done = false;

  constructor(
    private player: Player,
    private unitId: number,
    private troops: number,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.done = true;
    const tank = mg.unit(this.unitId);
    if (
      tank === undefined ||
      !FocusTankExecution.canFocus(mg, this.player, tank)
    ) {
      return;
    }
    const perHealth = mg.config().focusTroopsPerHealth();
    const troops = Math.min(
      Math.floor(this.troops),
      Math.floor(this.player.troops()),
    );
    const needed = tank.health() * perHealth;
    const spent = Math.min(troops, needed);
    const damage = Math.floor(spent / perHealth);
    if (damage <= 0) return;
    this.player.removeTroops(damage * perHealth);
    tank.modifyHealth(-damage, this.player);
  }

  /** Whether `player` may Focus `tank` right now (shared with the client). */
  static canFocus(mg: Game, player: Player, tank: Unit): boolean {
    if (tank.type() !== UnitType.Tank || !tank.isActive()) return false;
    const owner = tank.owner();
    if (owner === player || !player.canAttackPlayer(owner, true)) return false;
    return nearOwnLand(mg, player, tank, mg.config().focusRange());
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return !this.done;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return FocusTankExecutionSnapshot.write({
      player: w.player(this.player),
      unitId: this.unitId,
      troops: this.troops,
      done: this.done,
    });
  }

  restoreSnapshot(s: FocusTankState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.unitId = s.unitId;
    this.troops = s.troops;
    this.done = s.done;
  }
}

function nearOwnLand(mg: Game, player: Player, tank: Unit, range: number) {
  const map = mg.map();
  const cx = map.x(tank.tile());
  const cy = map.y(tank.tile());
  const id = player.smallID();
  for (let y = cy - range; y <= cy + range; y++) {
    if (y < 0 || y >= map.height()) continue;
    for (let x = cx - range; x <= cx + range; x++) {
      if (x < 0 || x >= map.width()) continue;
      if (map.ownerID(map.ref(x, y)) === id) return true;
    }
  }
  return false;
}

// unitId and troops are untrusted intent data (validated in init).
const FocusTankStateSchema = z.object({
  player: zPlayerRef(),
  unitId: zNum(),
  troops: zNum(),
  done: z.boolean(),
});
type FocusTankState = z.infer<typeof FocusTankStateSchema>;

export const FocusTankExecutionSnapshot = execSnapshotType({
  name: "FocusTank",
  version: 1,
  schema: FocusTankStateSchema,
  cls: () => FocusTankExecution,
});
