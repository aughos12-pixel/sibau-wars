import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Player,
  Unit,
  UnitParams,
} from "../game/Game";
import { findLandPath } from "../pathfinding/algorithms/AStar.Land";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { ShellExecution } from "./ShellExecution";

/**
 * Sibau Wars: a tank. It rolls out of a Barracks and drives over land
 * (anyone's) to the tile its owner ordered, shooting enemy tanks in range on
 * the way.
 *
 * With no order to follow it raids: next to an enemy building it stops and
 * wrecks it, and on enemy land it drives to the nearest enemy building it
 * can see. A move order always wins over raiding.
 *
 * Its owner's attacks are faster and cheaper near it (see AttackExecution).
 */
export class TankExecution implements Execution {
  private mg: Game;
  private tank: Unit | undefined;
  private active = true;

  /** Path to `pathGoal`, walked from `pathIndex`. */
  private path: TileRef[] | null = null;
  private pathIndex = 0;
  private pathGoal: TileRef | undefined;
  private moveTimer = 0;

  private lastShot = -1000;
  private wreckTarget: Unit | null = null;
  private wreckProgress = 0;
  private raidTarget: Unit | null = null;

  constructor(
    private input: (Required<UnitParams<UnitType.Tank>> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.tank = this.input;
      return;
    }
    const { owner, targetTile } = this.input;
    const spawn = owner.canBuild(UnitType.Tank, targetTile);
    if (spawn === false) {
      console.warn(`Failed to spawn tank for ${owner.name()} at ${targetTile}`);
      this.active = false;
      return;
    }
    this.tank = owner.buildUnit(UnitType.Tank, spawn, { targetTile });
  }

  tick(ticks: number): void {
    const tank = this.tank;
    if (tank === undefined || !tank.isActive()) {
      this.active = false;
      return;
    }
    if (tank.health() <= 0) {
      tank.delete();
      this.active = false;
      return;
    }

    this.fightTanks(ticks, tank);

    const order = tank.targetTile();
    if (order === undefined) {
      if (this.wreck(tank)) return;
      this.raid(tank);
    } else {
      this.raidTarget = null;
      this.wreckTarget = null;
      this.wreckProgress = 0;
    }

    const goal = order ?? this.raidTarget?.tile();
    this.drive(tank, goal);
  }

  private enemyOf(owner: Player, other: Player): boolean {
    return other !== owner && owner.canAttackPlayer(other, true);
  }

  private fightTanks(ticks: number, tank: Unit): void {
    const config = this.mg.config();
    const owner = tank.owner();
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const { unit, distSquared } of this.mg.nearbyUnits(
      tank.tile(),
      config.tankTargettingRange(),
      UnitType.Tank,
    )) {
      if (unit === tank || !this.enemyOf(owner, unit.owner())) continue;
      if (distSquared < bestDist) {
        best = unit;
        bestDist = distSquared;
      }
    }
    tank.setTargetUnit(best);
    if (best === undefined) return;
    if (ticks - this.lastShot < config.tankShellAttackRate()) return;
    this.lastShot = ticks;
    this.mg.addExecution(new ShellExecution(tank.tile(), owner, tank, best));
  }

  /** Returns true while the tank is busy wrecking a building. */
  private wreck(tank: Unit): boolean {
    const config = this.mg.config();
    const owner = tank.owner();
    const range = config.tankWreckRange();
    const t = this.wreckTarget;
    if (
      t !== null &&
      (!t.isActive() ||
        !this.enemyOf(owner, t.owner()) ||
        this.mg.euclideanDistSquared(t.tile(), tank.tile()) > range * range)
    ) {
      this.wreckTarget = null;
      this.wreckProgress = 0;
    }
    if (this.wreckTarget === null) {
      this.wreckTarget = this.nearestEnemyStructure(tank, range);
      this.wreckProgress = 0;
    }
    const target = this.wreckTarget;
    if (target === null) return false;
    this.wreckProgress++;
    if (this.wreckProgress >= config.tankWreckTicks()) {
      target.delete(true, owner);
      this.wreckTarget = null;
      this.wreckProgress = 0;
      this.raidTarget = null;
    }
    return true;
  }

  private raid(tank: Unit): void {
    const owner = tank.owner();
    const r = this.raidTarget;
    if (r !== null && (!r.isActive() || !this.enemyOf(owner, r.owner()))) {
      this.raidTarget = null;
    }
    if (this.raidTarget !== null) return;
    const landOwner = this.mg.owner(tank.tile());
    if (!landOwner.isPlayer() || !this.enemyOf(owner, landOwner)) return;
    this.raidTarget = this.nearestEnemyStructure(
      tank,
      this.mg.config().tankRaidSearchRange(),
    );
  }

  private nearestEnemyStructure(tank: Unit, range: number): Unit | null {
    const owner = tank.owner();
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const { unit, distSquared } of this.mg.nearbyUnits(
      tank.tile(),
      range,
      Structures.types,
      undefined,
      true,
    )) {
      if (!this.enemyOf(owner, unit.owner())) continue;
      if (
        distSquared < bestDist ||
        (distSquared === bestDist && best !== null && unit.id() < best.id())
      ) {
        best = unit;
        bestDist = distSquared;
      }
    }
    return best;
  }

  private drive(tank: Unit, goal: TileRef | undefined): void {
    if (goal === undefined) {
      this.path = null;
      this.pathGoal = undefined;
      return;
    }
    if (goal !== this.pathGoal) {
      this.pathGoal = goal;
      this.path = findLandPath(this.mg.map(), tank.tile(), goal);
      this.pathIndex = 1;
      if (this.path === null) {
        // Unreachable (across water, or too far): drop the order.
        this.arrive(tank);
        return;
      }
    }
    const path = this.path;
    if (path === null) return;
    if (this.pathIndex >= path.length) {
      this.arrive(tank);
      return;
    }
    this.moveTimer++;
    if (this.moveTimer < this.mg.config().tankTicksPerTile()) return;
    this.moveTimer = 0;
    tank.move(path[this.pathIndex++]);
    if (this.pathIndex >= path.length) this.arrive(tank);
  }

  private arrive(tank: Unit): void {
    this.path = null;
    this.pathGoal = undefined;
    if (tank.targetTile() !== undefined) {
      tank.setTargetTile(undefined);
      // setTargetTile sends no update; let clients see the order is done.
      tank.touch();
    }
    this.raidTarget = null;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return TankExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            targetTile: this.input.targetTile,
          },
      initialized: this.mg !== undefined,
      active: this.active,
      tank: this.tank === undefined ? null : w.unit(this.tank),
      path: this.path === null ? null : [...this.path],
      pathIndex: this.pathIndex,
      pathGoal: this.pathGoal,
      moveTimer: this.moveTimer,
      lastShot: this.lastShot,
      wreckTarget: w.unitOrNull(this.wreckTarget),
      wreckProgress: this.wreckProgress,
      raidTarget: w.unitOrNull(this.raidTarget),
    });
  }

  restoreSnapshot(s: TankExecutionState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : {
            owner: r.player(s.input.owner),
            targetTile: s.input.targetTile,
          };
    if (s.initialized) this.mg = r.game;
    this.active = s.active;
    if (s.tank !== null) this.tank = r.unit(s.tank);
    this.path = s.path === null ? null : [...s.path];
    this.pathIndex = s.pathIndex;
    this.pathGoal = s.pathGoal;
    this.moveTimer = s.moveTimer;
    this.lastShot = s.lastShot;
    this.wreckTarget = r.unitOrNull(s.wreckTarget);
    this.wreckProgress = s.wreckProgress;
    this.raidTarget = r.unitOrNull(s.raidTarget);
  }
}

const TankExecutionStateSchema = z.object({
  /** An existing tank, or the params to build one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({
      owner: zPlayerRef(),
      targetTile: zTile(),
    }),
  ]),
  initialized: z.boolean(),
  active: z.boolean(),
  tank: zRef().nullable(),
  path: z.array(zTile()).nullable(),
  pathIndex: zInt(),
  pathGoal: zTile().optional(),
  moveTimer: zInt(),
  lastShot: zInt(),
  wreckTarget: zRef().nullable(),
  wreckProgress: zInt(),
  raidTarget: zRef().nullable(),
});
type TankExecutionState = z.infer<typeof TankExecutionStateSchema>;

export const TankExecutionSnapshot = execSnapshotType({
  name: "Tank",
  version: 1,
  schema: TankExecutionStateSchema,
  cls: () => TankExecution,
});
