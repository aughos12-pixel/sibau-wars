import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { Government, Tech } from "@openfront/engine-api/game/Sibau";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  DemandVassalExecution,
  ResearchExecution,
  SearchOilExecution,
  SetGovernmentExecution,
  VassalReplyExecution,
} from "@openfront/engine/execution/SibauExecutions";
import {
  SibauWorldExecution,
  sibauWorld,
} from "@openfront/engine/execution/SibauWorldExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";
import { constructionExecution, executeTicks } from "./util/utils";

let game: Game;
let left: Player;
let right: Player;

function addPlayer(id: string, x: number, y: number, type = PlayerType.Human) {
  game.addPlayer(new PlayerInfo(id, type, null, id));
  game.addExecution(
    new SpawnExecution("g", game.player(id).info(), game.ref(x, y)),
  );
  return game.player(id);
}

/** Two halves of the 200x200 plains, still in the spawn phase unless `start`. */
async function halves(
  opts: { start?: boolean; rightType?: PlayerType; leftShare?: number } = {},
) {
  game = await setup(
    "big_plains",
    { infiniteGold: false, instantBuild: true },
    [],
    undefined,
    UseRealAttackLogic,
    false,
  );
  left = addPlayer("left", 30, 100);
  right = addPlayer("right", 170, 100, opts.rightType ?? PlayerType.Human);
  executeTicks(game, 2);
  const split = Math.round(200 * (opts.leftShare ?? 0.5));
  for (let x = 0; x < 200; x++) {
    for (let y = 0; y < 200; y++) {
      (x < split ? left : right).conquer(game.ref(x, y));
    }
  }
  if (opts.start !== false) {
    game.endSpawnPhase();
    executeTicks(game, 1);
  }
}

const gov = (p: Player) => p.sibauState().government();

describe("Governments (Sibau Wars)", () => {
  test("is picked once and then locked", async () => {
    await halves();
    game.addExecution(new SetGovernmentExecution(left, Government.Junta));
    executeTicks(game, 1);
    expect(gov(left)).toBe(Government.Junta);
    game.addExecution(new SetGovernmentExecution(left, Government.Republic));
    executeTicks(game, 2);
    expect(gov(left)).toBe(Government.Junta);
  });

  test("players who never pick get Monarchy shortly after the spawn phase", async () => {
    await halves();
    expect(gov(right)).toBeNull();
    executeTicks(game, 310);
    expect(gov(right)).toBe(Government.Monarchy);
  });

  test("each government changes the right numbers", async () => {
    await halves();
    const config = game.config();
    const goldBefore = config.goldAdditionRate(left);
    const capBefore = config.maxTroops(left);
    const tankBefore = game.unitInfo(UnitType.Tank).cost(game, left);

    left.sibauState().setGovernment(Government.Republic);
    expect(Number(config.goldAdditionRate(left))).toBeCloseTo(
      Number(goldBefore) * 1.25,
      -1,
    );

    left.sibauState().setGovernment(Government.Monarchy);
    expect(config.maxTroops(left) / capBefore).toBeCloseTo(1.1);

    left.sibauState().setGovernment(Government.Junta);
    expect(Number(game.unitInfo(UnitType.Tank).cost(game, left))).toBe(
      Number(tankBefore) * 0.75,
    );

    right.sibauState().setGovernment(Government.Theocracy);
    const base = {
      terrain: TerrainType.Plains,
      attackTroops: 100_000,
      attacker: { type: PlayerType.Human, numTiles: 10_000 },
      defender: {
        type: PlayerType.Human,
        numTiles: 10_000,
        troops: 100_000,
        isTraitor: false,
        isDisconnectedTeammate: false,
      },
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 50,
    };
    const plain = config.attackLogic(base).attackerTroopLoss;
    const vsTheocracy = config.attackLogic({
      ...base,
      defenderSibau: right.sibau(),
    }).attackerTroopLoss;
    const asJunta = config.attackLogic({
      ...base,
      attackerSibau: left.sibau(),
    }).attackerTroopLoss;
    expect(vsTheocracy / plain).toBeCloseTo(1.15);
    expect(asJunta / plain).toBeCloseTo(0.9);
  });
});

describe("Capitals (Sibau Wars)", () => {
  test("the first City is the capital; losing it halves troop growth until a new City", async () => {
    await halves();
    left.addGold(5_000_000n);
    constructionExecution(game, left, 30, 60, UnitType.City);
    const capital = left.units(UnitType.City)[0];
    expect(left.sibau().capitalUnitID).toBe(capital.id());

    left.removeTroops(left.troops() - 10_000);
    const before = game.config().troopIncreaseRate(left);
    // The enemy takes the capital's tile, so it changes hands.
    right.conquer(capital.tile());
    executeTicks(game, 2);
    expect(left.sibau().capitalLost).toBe(true);
    expect(left.sibau().capitalUnitID).toBeNull();
    left.removeTroops(left.troops() - 10_000);
    expect(game.config().troopIncreaseRate(left) / before).toBeCloseTo(0.5, 1);

    constructionExecution(game, left, 30, 140, UnitType.City);
    const fresh = left.units(UnitType.City).find((c) => c !== capital)!;
    expect(left.sibau().capitalLost).toBe(false);
    expect(left.sibau().capitalUnitID).toBe(fresh.id());
  });
});

describe("Research (Sibau Wars)", () => {
  test("points trickle in, faster with Schools", async () => {
    await halves();
    executeTicks(game, 200);
    const slow = left.sibau().research;
    expect(slow).toBeGreaterThanOrEqual(1);
    left.addGold(5_000_000n);
    constructionExecution(game, left, 30, 30, UnitType.School);
    const start = left.sibauState().research();
    executeTicks(game, 200);
    // 1 trickle + 1 School per 10 s.
    expect(left.sibauState().research() - start).toBeGreaterThanOrEqual(3.5);
  });

  test("techs cost points, need the one before, and work", async () => {
    await halves();
    const goldBefore = game.config().goldAdditionRate(left);
    left.sibauState().addResearch(12);
    game.addExecution(new ResearchExecution(left, Tech.Banking));
    executeTicks(game, 1);
    expect(left.sibauState().hasTech(Tech.Banking)).toBe(false);
    game.addExecution(new ResearchExecution(left, Tech.TradeRoutes));
    executeTicks(game, 1);
    expect(left.sibauState().hasTech(Tech.TradeRoutes)).toBe(true);
    expect(left.sibauState().research()).toBeLessThan(3);
    expect(Number(game.config().goldAdditionRate(left))).toBeCloseTo(
      Number(goldBefore) * 1.15,
      -1,
    );
  });
});

describe("Oil (Sibau Wars)", () => {
  test("hidden fields avoid mountains and are spread out", async () => {
    await halves();
    const fields = sibauWorld(game).oilFields;
    expect(fields.length).toBeGreaterThanOrEqual(3);
    for (const f of fields) {
      expect(game.terrainType(f)).not.toBe(TerrainType.Mountain);
    }
  });

  test("a hit reveals the field and allows a drill that pumps gold; a miss loses the money", async () => {
    await halves();
    const field = sibauWorld(game).oilFields.find(
      (f) => game.owner(f) === left,
    );
    expect(field).toBeDefined();

    // A miss: search far from every field.
    const far = [...left.tiles()].find((t) =>
      sibauWorld(game).oilFields.every(
        (f) => game.euclideanDistSquared(f, t) > 30 * 30,
      ),
    );
    if (far !== undefined) {
      left.addGold(5_000_000n);
      const before = left.gold();
      game.addExecution(new SearchOilExecution(left, far));
      executeTicks(game, 1);
      expect(Number(before - left.gold())).toBeGreaterThan(4_990_000);
      expect(game.units(UnitType.OilField)).toHaveLength(0);
    }

    left.addGold(5_000_000n);
    game.addExecution(new SearchOilExecution(left, field!));
    executeTicks(game, 1);
    expect(game.units(UnitType.OilField)).toHaveLength(1);

    left.addGold(2_000_000n);
    const x = game.x(field!);
    const y = game.y(field!);
    constructionExecution(game, left, x, y, UnitType.OilDrill);
    expect(left.units(UnitType.OilDrill)).toHaveLength(1);
    const before = left.gold();
    executeTicks(game, 10);
    // 20k a second from the drill, plus a little worker income.
    expect(Number(left.gold() - before)).toBeGreaterThan(20_000);
  });

  test("a drill needs a found field", async () => {
    await halves();
    left.addGold(2_000_000n);
    expect(left.canBuild(UnitType.OilDrill, game.ref(30, 30))).toBe(false);
  });
});

describe("Vassals (Sibau Wars)", () => {
  test("an AI gives in to someone with 3x its troops, and pays tribute", async () => {
    await halves({ rightType: PlayerType.Nation, leftShare: 0.7 });
    right.removeTroops(right.troops() - 10_000);
    left.addTroops(100_000);
    game.addExecution(new DemandVassalExecution(left, right.id()));
    executeTicks(game, 1);
    expect(right.sibauState().overlord()).toBe(left);
    expect(left.canAttackPlayer(right)).toBe(false);
    expect(right.canAttackPlayer(left)).toBe(false);
  });

  test("an AI refuses someone who isn't strong enough", async () => {
    await halves({ rightType: PlayerType.Nation, leftShare: 0.7 });
    game.addExecution(new DemandVassalExecution(left, right.id()));
    executeTicks(game, 1);
    expect(right.sibauState().overlord()).toBeNull();
  });

  test("only someone bigger can demand", async () => {
    await halves({ leftShare: 0.3 });
    game.addExecution(new DemandVassalExecution(left, right.id()));
    executeTicks(game, 1);
    expect(right.sibauState().vassalDemands()).toHaveLength(0);
  });

  test("a human decides, and a vassal goes free once it outgrows its overlord", async () => {
    await halves({ leftShare: 0.7 });
    game.addExecution(new DemandVassalExecution(left, right.id()));
    executeTicks(game, 1);
    expect(right.sibauState().vassalDemands()).toHaveLength(1);
    game.addExecution(new VassalReplyExecution(right, left.id(), true));
    executeTicks(game, 1);
    expect(right.sibauState().overlord()).toBe(left);

    const overlordGold = left.gold();
    executeTicks(game, 10);
    // Tribute: the overlord earns more than its own worker income.
    expect(left.gold() - overlordGold).toBeGreaterThan(
      game.config().goldAdditionRate(left) * 10n,
    );

    for (let x = 80; x < 140; x++) {
      for (let y = 0; y < 200; y++) right.conquer(game.ref(x, y));
    }
    executeTicks(game, 2);
    expect(right.sibauState().overlord()).toBeNull();
  });
});

describe("War exhaustion and rebels (Sibau Wars)", () => {
  test("long wars build exhaustion, which cuts troop growth", async () => {
    await halves();
    left.sibauState().setGovernment(Government.Republic);
    left.addTroops(500_000);
    game.addExecution(new AttackExecution(400_000, left, right.id()));
    executeTicks(game, 5);
    expect(left.outgoingAttacks().length).toBe(1);
    // Keep the war going.
    for (let i = 0; i < 30; i++) {
      if (left.outgoingAttacks().length === 0) {
        left.addTroops(50_000);
        game.addExecution(new AttackExecution(40_000, left, right.id()));
      }
      executeTicks(game, 20);
    }
    expect(left.sibau().exhaustion).toBeGreaterThan(3);
    expect(game.config().sibauTroopGrowth(left)).toBeLessThan(0.98);
    // And it fades in peace.
    const peak = left.sibau().exhaustion;
    while (left.outgoingAttacks().length > 0) executeTicks(game, 10);
    executeTicks(game, 200);
    expect(left.sibau().exhaustion).toBeLessThan(peak);
  });

  test("taking too much land too fast makes some of it rebel", async () => {
    await halves({ leftShare: 0.3 });
    // Grab a huge chunk of the enemy at once.
    for (let x = 60; x < 140; x++) {
      for (let y = 0; y < 200; y++) left.conquer(game.ref(x, y));
    }
    const playersBefore = game.allPlayers().length;
    executeTicks(game, 1500);
    const rebels = game
      .allPlayers()
      .filter((p) => p.name().startsWith("Rebels of"));
    expect(game.allPlayers().length).toBeGreaterThan(playersBefore);
    expect(rebels.length).toBeGreaterThan(0);
    expect(rebels[0].numTilesOwned()).toBeGreaterThan(0);
  });
});

describe("Coalitions (Sibau Wars)", () => {
  test("nations gang up on a runaway leader", async () => {
    game = await setup(
      "big_plains",
      { infiniteGold: false, instantBuild: true },
      [],
      undefined,
      UseRealAttackLogic,
      false,
    );
    const giant = addPlayer("giant", 30, 100);
    const a = addPlayer("a", 170, 30, PlayerType.Nation);
    const b = addPlayer("b", 170, 170, PlayerType.Nation);
    executeTicks(game, 2);
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) {
        const owner = x < 150 ? giant : y < 100 ? a : b;
        owner.conquer(game.ref(x, y));
      }
    }
    game.addExecution(new SibauWorldExecution(1));
    game.endSpawnPhase();
    executeTicks(game, 120);
    const world = sibauWorld(game);
    expect(world.coalitionTarget).toBe(giant);
    expect(world.coalitionMembers.has(a)).toBe(true);
    expect(world.coalitionMembers.has(b)).toBe(true);
  });
});
