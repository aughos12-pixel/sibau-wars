import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { FocusTankExecution } from "../FocusTankExecution";
import { MoveWarshipExecution } from "../MoveWarshipExecution";

/** Most tanks a nation keeps at once, by difficulty. */
const MAX_TANKS: Record<Difficulty, number> = {
  [Difficulty.Easy]: 1,
  [Difficulty.Medium]: 2,
  [Difficulty.Hard]: 3,
  [Difficulty.Impossible]: 4,
};

/** Gold kept back after buying a tank (in multiples of the tank's cost). */
const TANK_GOLD_RESERVE = 1;

/** Share of a nation's troops it will throw at one enemy tank. */
const FOCUS_TROOP_SHARE = 0.25;

/** How far from a Barracks a nation looks for enemy buildings to raid. */
const RAID_SEARCH_RANGE = 80;

/** Border tiles sampled when looking for an enemy tile to send a tank to. */
const BORDER_SAMPLES = 60;

/**
 * Sibau Wars: how nations use tanks. Stateless (everything is read from the
 * game each time), so it needs no snapshot.
 *
 * - Focus: troops thrown at an enemy tank in or next to the nation's land.
 * - Build: with a working Barracks, spare gold and an enemy next door, a
 *   tank is ordered toward that enemy's nearest building.
 * - Command: idle tanks at home are sent at the enemy. Once on enemy land
 *   TankExecution raids by itself.
 */
export class NationTankBehavior {
  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  handleTanks(): void {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.Tank)) return;
    if (this.focusEnemyTank()) return;
    const enemy = this.pickEnemy();
    if (enemy === null) return;
    const target = this.targetTile(enemy);
    if (target === null) return;
    this.sendIdleTanks(target);
    this.maybeBuildTank(target);
  }

  private focusEnemyTank(): boolean {
    const me = this.player;
    for (const tank of this.game.units(UnitType.Tank)) {
      if (!FocusTankExecution.canFocus(this.game, me, tank)) continue;
      // Only once it's inside our land: tanks passing by aren't worth it.
      if (this.game.owner(tank.tile()) !== me) continue;
      const perHealth = this.game.config().focusTroopsPerHealth();
      const needed = tank.health() * perHealth;
      const troops = Math.min(
        needed,
        Math.floor(me.troops() * FOCUS_TROOP_SHARE),
      );
      // Not worth chipping at it with a handful of troops.
      if (troops < needed / 3) continue;
      this.game.addExecution(new FocusTankExecution(me, tank.id(), troops));
      return true;
    }
    return false;
  }

  /** The enemy we're already attacking, else a random hostile neighbor. */
  private pickEnemy(): Player | null {
    const me = this.player;
    for (const attack of me.outgoingAttacks()) {
      const t = attack.target();
      if (t.isPlayer() && me.canAttackPlayer(t, true)) return t;
    }
    const neighbors = me
      .nearby()
      .filter(
        (n): n is Player =>
          n.isPlayer() &&
          n !== me &&
          me.sharesBorderWith(n) &&
          me.canAttackPlayer(n, true),
      )
      .sort((a, b) => a.smallID() - b.smallID());
    if (neighbors.length === 0) return null;
    return neighbors[this.random.nextInt(0, neighbors.length)];
  }

  /** The enemy's building nearest one of our Barracks, else enemy land on our border. */
  private targetTile(enemy: Player): TileRef | null {
    const barracks = this.workingBarracks();
    let best: Unit | null = null;
    let bestDist = Infinity;
    for (const b of barracks) {
      for (const u of enemy.units(Structures.types)) {
        const d = this.game.manhattanDist(b.tile(), u.tile());
        if (d <= RAID_SEARCH_RANGE && d < bestDist) {
          best = u;
          bestDist = d;
        }
      }
    }
    if (best !== null) return best.tile();

    const border = Array.from(this.player.borderTiles());
    for (let i = 0; i < Math.min(BORDER_SAMPLES, border.length); i++) {
      const tile = border[this.random.nextInt(0, border.length)];
      for (const n of this.game.neighbors(tile)) {
        if (this.game.owner(n) === enemy && this.game.isLand(n)) return n;
      }
    }
    return null;
  }

  private workingBarracks(): Unit[] {
    return this.player
      .units(UnitType.Barracks)
      .filter(
        (b) => b.isActive() && !b.isUnderConstruction() && !b.isDisabled(),
      );
  }

  private sendIdleTanks(target: TileRef): void {
    const idle = this.player
      .units(UnitType.Tank)
      .filter(
        (t) =>
          t.isActive() &&
          t.targetTile() === undefined &&
          this.game.owner(t.tile()) === this.player,
      )
      .map((t) => t.id());
    if (idle.length === 0) return;
    this.game.addExecution(new MoveWarshipExecution(this.player, idle, target));
  }

  private maybeBuildTank(target: TileRef): void {
    const me = this.player;
    const { difficulty } = this.game.config().gameConfig();
    if (me.units(UnitType.Tank).length >= MAX_TANKS[difficulty]) return;
    if (this.workingBarracks().length === 0) return;
    const cost = this.game.unitInfo(UnitType.Tank).cost(this.game, me);
    if (me.gold() < cost * BigInt(1 + TANK_GOLD_RESERVE)) return;
    if (me.canBuild(UnitType.Tank, target) === false) return;
    this.game.addExecution(
      new ConstructionExecution(me, UnitType.Tank, target),
    );
  }
}
