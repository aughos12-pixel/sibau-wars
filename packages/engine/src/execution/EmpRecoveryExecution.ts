import {
  zInt,
  zPlayerRef,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Sibau Wars: when an EMP's effect ends, send each hit structure's state
 * again so clients redraw it as switched back on.
 *
 * The engine itself needs nothing here: Unit.isDisabled() compares the
 * current tick against the unit's disabledUntil, so structures start working
 * again on their own. Only the client, which sees a disabled flag in unit
 * updates, has to be told.
 */
export class EmpRecoveryExecution implements Execution {
  private active = true;

  constructor(
    private player: Player,
    private units: Unit[],
    private untilTick: number,
  ) {}

  init(_mg: Game, _ticks: number): void {}

  tick(ticks: number): void {
    if (ticks < this.untilTick) return;
    for (const unit of this.units) {
      // A later EMP may have pushed the end back; its own recovery covers it.
      if (unit.isActive() && unit.disabledUntil() === this.untilTick) {
        unit.touch();
      }
    }
    this.active = false;
  }

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return EmpRecoveryExecutionSnapshot.write({
      active: this.active,
      player: w.player(this.player),
      // Deleted units can't be referenced; they need no redraw anyway.
      units: this.units.filter((u) => u.isActive()).map((u) => w.unit(u)),
      untilTick: this.untilTick,
    });
  }

  restoreSnapshot(s: EmpRecoveryState, r: SnapshotReader): void {
    this.active = s.active;
    this.player = r.player(s.player);
    this.units = s.units.map((u) => r.unit(u));
    this.untilTick = s.untilTick;
  }
}

const EmpRecoveryStateSchema = z.object({
  active: z.boolean(),
  player: zPlayerRef(),
  units: z.array(zRef()),
  untilTick: zInt(),
});
type EmpRecoveryState = z.infer<typeof EmpRecoveryStateSchema>;

export const EmpRecoveryExecutionSnapshot = execSnapshotType({
  name: "EmpRecovery",
  version: 1,
  schema: EmpRecoveryStateSchema,
  cls: () => EmpRecoveryExecution,
});
