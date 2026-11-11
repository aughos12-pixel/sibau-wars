import {
  Difficulty,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GOVERNMENTS,
  TECHS,
  TechBranch,
} from "@openfront/engine-api/game/Sibau";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { Game, Player } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import {
  canDemandVassal,
  canResearch,
  DemandVassalExecution,
  oilSearchProblem,
  ResearchExecution,
  SearchOilExecution,
  SetGovernmentExecution,
} from "../SibauExecutions";
import { randTerritoryTileArray } from "./NationUtils";

const BRANCH_ORDERS: readonly TechBranch[][] = [
  [TechBranch.Military, TechBranch.Economy, TechBranch.Defense],
  [TechBranch.Economy, TechBranch.Military, TechBranch.Defense],
  [TechBranch.Defense, TechBranch.Economy, TechBranch.Military],
  [TechBranch.Economy, TechBranch.Defense, TechBranch.Military],
];

/**
 * Sibau Wars: how nations use governments, research, oil and vassals.
 * Stateless (read from the game each turn), so it needs no snapshot.
 */
/** Nations only gamble on oil this long after the spawn phase (6 min). */
const NATION_OIL_AFTER_TICKS = 6 * 60 * 10;
/** Most test wells a nation will drill in a game. */
const MAX_NATION_OIL_SEARCHES = 2;

/** Most vassals a nation will collect. */
const MAX_NATION_VASSALS = 1;

export class NationSibauBehavior {
  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  handle(): void {
    const state = this.player.sibauState();
    if (state.government() === null) {
      const pick =
        GOVERNMENTS[simpleHash(this.player.id()) % GOVERNMENTS.length];
      this.game.addExecution(new SetGovernmentExecution(this.player, pick));
    }
    this.research();
    this.buildOilDrill();
    this.searchOil();
    this.demandVassal();
  }

  /** Each nation sticks to its own branch order (from its id). */
  private research() {
    const order =
      BRANCH_ORDERS[
        simpleHash(this.player.id() + "tech") % BRANCH_ORDERS.length
      ];
    for (const branch of order) {
      const next = TECHS.filter((t) => t.branch === branch).find(
        (t) => !this.player.sibauState().hasTech(t.tech),
      );
      if (next !== undefined && canResearch(this.player, next.tech)) {
        this.game.addExecution(new ResearchExecution(this.player, next.tech));
        return;
      }
      if (next !== undefined) return; // saving up for it
    }
  }

  /** A found field on our land gets a drill as soon as we can afford one. */
  private buildOilDrill() {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.OilDrill)) return;
    const cost = this.game
      .unitInfo(UnitType.OilDrill)
      .cost(this.game, this.player);
    if (this.player.gold() < cost) return;
    const range = config.oilDrillRange();
    for (const field of this.game.units(UnitType.OilField)) {
      if (!field.isActive()) continue;
      const center = field.tile();
      if (this.game.owner(center) !== this.player) continue;
      const cx = this.game.x(center);
      const cy = this.game.y(center);
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
          if (!this.game.isValidCoord(cx + dx, cy + dy)) continue;
          const tile = this.game.ref(cx + dx, cy + dy);
          if (this.player.canBuild(UnitType.OilDrill, tile) === false) continue;
          this.game.addExecution(
            new ConstructionExecution(this.player, UnitType.OilDrill, tile),
          );
          return;
        }
      }
    }
  }

  /** Rich nations on Medium and up sometimes gamble on oil, on flat land. */
  /**
   * Some nations (1 in 3, from their id) gamble on oil once they are big:
   * they save up and drill at most MAX_NATION_OIL_SEARCHES test wells.
   */
  wantsOil(): boolean {
    const game = this.game;
    if (game.config().gameConfig().difficulty === Difficulty.Easy) return false;
    if (game.config().isUnitDisabled(UnitType.OilDrill)) return false;
    if (simpleHash(this.player.id() + "oil") % 3 !== 0) return false;
    if (this.player.numTilesOwned() < 1500) return false;
    const start = game.spawnPhaseEndTick();
    if (start === null || game.ticks() - start < NATION_OIL_AFTER_TICKS) {
      return false;
    }
    if (this.player.sibauState().oilSearches() >= MAX_NATION_OIL_SEARCHES) {
      return false;
    }
    // Already struck oil: no need to gamble again.
    return !game
      .units(UnitType.OilField)
      .some((f) => f.isActive() && f.owner() === this.player);
  }

  /** True while we hold gold back from buildings for a test well. */
  isSavingForOil(): boolean {
    return (
      this.wantsOil() && this.player.gold() < this.game.config().oilSearchCost()
    );
  }

  private searchOil() {
    if (!this.wantsOil()) return;
    if (this.player.gold() < this.game.config().oilSearchCost()) return;
    for (const tile of randTerritoryTileArray(
      this.random,
      this.game,
      this.player,
      10,
    )) {
      if (this.game.magnitude(tile) > 20) continue; // skip highlands
      if (oilSearchProblem(this.game, this.player, tile) !== null) continue;
      this.game.addExecution(new SearchOilExecution(this.player, tile));
      return;
    }
  }

  /** Hard and Impossible nations bully much weaker neighbors. */
  private demandVassal() {
    const { difficulty } = this.game.config().gameConfig();
    if (
      difficulty !== Difficulty.Hard &&
      difficulty !== Difficulty.Impossible
    ) {
      return;
    }
    if (!this.random.chance(20)) return;
    // A few vassals each, so AI empires don't swallow the whole map.
    const vassals = this.game
      .players()
      .filter((p) => p.sibauState().overlord() === this.player).length;
    if (vassals >= MAX_NATION_VASSALS) return;
    const ratio = this.game.config().vassalAcceptTroopRatio();
    const weak = this.player
      .nearby()
      .filter(
        (p): p is Player =>
          p.isPlayer() &&
          p.type() !== PlayerType.Bot &&
          this.player.sharesBorderWith(p) &&
          canDemandVassal(this.player, p) &&
          this.player.troops() >= p.troops() * ratio &&
          // Only real minnows: at least 3x smaller as well.
          this.player.numTilesOwned() >= p.numTilesOwned() * 3,
      )
      .sort((a, b) => a.smallID() - b.smallID());
    if (weak.length === 0) return;
    const target = weak[this.random.nextInt(0, weak.length)];
    this.game.addExecution(new DemandVassalExecution(this.player, target.id()));
  }
}
