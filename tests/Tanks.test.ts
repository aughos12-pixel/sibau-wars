import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { FocusTankExecution } from "@openfront/engine/execution/FocusTankExecution";
import { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { findLandPath } from "@openfront/engine/pathfinding/algorithms/AStar.Land";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";
import { constructionExecution, executeTicks } from "./util/utils";

let game: Game;
let attacker: Player;
let defender: Player;

function addPlayer(id: string, x: number, y: number): Player {
  game.addPlayer(new PlayerInfo(id, PlayerType.Human, null, id));
  game.addExecution(
    new SpawnExecution("g", game.player(id).info(), game.ref(x, y)),
  );
  return game.player(id);
}

/** Attacker holds x < 50, defender x >= 50, on the 200x200 plains. */
async function frontGame(configClass?: typeof UseRealAttackLogic) {
  game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true },
    [],
    undefined,
    configClass,
  );
  attacker = addPlayer("attacker", 20, 100);
  defender = addPlayer("defender", 120, 100);
  executeTicks(game, 2);
  for (let x = 0; x < 200; x++) {
    for (let y = 0; y < 200; y++) {
      (x < 50 ? attacker : defender).conquer(game.ref(x, y));
    }
  }
  attacker.addTroops(1_000_000);
  defender.addTroops(1_000_000);
}

/** Builds a Barracks for `p` at (x, y), then orders a tank to (tx, ty). */
function buildTank(p: Player, x: number, y: number, tx: number, ty: number) {
  if (p.units(UnitType.Barracks).length === 0) {
    constructionExecution(game, p, x, y, UnitType.Barracks);
  }
  const before = new Set(p.units(UnitType.Tank));
  constructionExecution(game, p, tx, ty, UnitType.Tank);
  const tank = p.units(UnitType.Tank).find((t) => !before.has(t));
  expect(tank).toBeDefined();
  return tank!;
}

function at(u: Unit): [number, number] {
  return [game.x(u.tile()), game.y(u.tile())];
}

function runUntil(cond: () => boolean, maxTicks: number): number {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return i;
    game.executeNextTick();
  }
  return -1;
}

describe("Barracks and tanks (Sibau Wars)", () => {
  test("a tank needs a working Barracks", async () => {
    await frontGame();
    expect(attacker.canBuild(UnitType.Tank, game.ref(30, 100))).toBe(false);
    constructionExecution(game, attacker, 20, 100, UnitType.Barracks);
    expect(attacker.units(UnitType.Barracks)).toHaveLength(1);
    expect(attacker.canBuild(UnitType.Tank, game.ref(30, 100))).toBe(
      attacker.units(UnitType.Barracks)[0].tile(),
    );
  });

  test("a tank rolls out of the Barracks and drives over enemy land to its order", async () => {
    await frontGame();
    const tank = buildTank(attacker, 20, 100, 90, 100);
    expect(at(tank)[0]).toBeLessThan(25);
    // 70 tiles at 2 ticks per tile.
    const took = runUntil(() => tank.tile() === game.ref(90, 100), 400);
    expect(took).toBeGreaterThan(100);
    expect(tank.targetTile()).toBeUndefined();
  });

  test("a move order sends a tank somewhere else", async () => {
    await frontGame();
    const tank = buildTank(attacker, 20, 100, 30, 100);
    runUntil(() => tank.targetTile() === undefined, 200);
    game.addExecution(
      new MoveWarshipExecution(attacker, [tank.id()], game.ref(30, 160)),
    );
    expect(runUntil(() => tank.tile() === game.ref(30, 160), 300)).not.toBe(-1);
  });

  test("tanks drive on land only", async () => {
    game = await setup("half_land_half_ocean", {
      infiniteGold: true,
      instantBuild: true,
    });
    const map = game.map();
    let land = -1;
    let water = -1;
    for (let t = 0; t < map.width() * map.height(); t++) {
      if (land === -1 && map.isLand(t) && !map.isImpassable(t)) land = t;
      if (water === -1 && map.isWater(t)) water = t;
    }
    expect(findLandPath(map, land, water)).toBeNull();
    const path = findLandPath(map, land, land + 1);
    if (map.isLand(land + 1)) expect(path).toEqual([land, land + 1]);
  });

  test("a parked tank on enemy land wrecks nearby enemy buildings", async () => {
    await frontGame();
    constructionExecution(game, defender, 90, 100, UnitType.City);
    const city = defender.units(UnitType.City)[0];
    expect(city).toBeDefined();
    // Park within raid range but outside wreck range: the tank finds the
    // city on its own, drives up and wrecks it.
    buildTank(attacker, 20, 100, 78, 100);
    expect(runUntil(() => !city.isActive(), 600)).not.toBe(-1);
  });

  test("a tank does not wreck buildings while following a move order", async () => {
    await frontGame();
    constructionExecution(game, defender, 90, 100, UnitType.City);
    const city = defender.units(UnitType.City)[0];
    // Drive right past the city to a point far beyond it.
    buildTank(attacker, 20, 100, 190, 100);
    executeTicks(game, 120);
    expect(city.isActive()).toBe(true);
  });

  test("enemy tanks shoot each other", async () => {
    await frontGame();
    const a = buildTank(attacker, 20, 100, 52, 100);
    const d = buildTank(defender, 120, 100, 58, 100);
    expect(runUntil(() => !a.isActive() || !d.isActive(), 800)).not.toBe(-1);
  });

  test("defense posts shoot enemy tanks", async () => {
    await frontGame();
    constructionExecution(game, defender, 100, 100, UnitType.DefensePost);
    const tank = buildTank(attacker, 20, 100, 85, 100);
    runUntil(() => tank.targetTile() === undefined, 400);
    const health = tank.health();
    executeTicks(game, 120);
    expect(tank.health()).toBeLessThan(health);
  });

  test("Focus spends troops to destroy an enemy tank near your land", async () => {
    await frontGame();
    const tank = buildTank(attacker, 20, 100, 55, 100);
    runUntil(() => tank.targetTile() === undefined, 300);
    const troops = defender.troops();
    game.addExecution(new FocusTankExecution(defender, tank.id(), 500_000));
    executeTicks(game, 2);
    expect(tank.isActive()).toBe(false);
    const spent = troops - defender.troops();
    // 1000 health at 150 troops each; the rest of the 500k is kept.
    // Troop growth over the two ticks makes the drop a little smaller.
    expect(spent).toBeGreaterThan(140_000);
    expect(spent).toBeLessThan(200_000);
  });

  test("Focus with too few troops only damages the tank", async () => {
    await frontGame();
    const tank = buildTank(attacker, 20, 100, 55, 100);
    runUntil(() => tank.targetTile() === undefined, 300);
    game.addExecution(new FocusTankExecution(defender, tank.id(), 30_000));
    executeTicks(game, 2);
    expect(tank.isActive()).toBe(true);
    expect(tank.health()).toBe(800);
  });

  test("Focus cannot reach your own tanks or tanks far from your land", async () => {
    await frontGame();
    const tank = buildTank(attacker, 20, 100, 25, 100);
    runUntil(() => tank.targetTile() === undefined, 300);
    game.addExecution(new FocusTankExecution(attacker, tank.id(), 500_000));
    // 25 tiles from the defender's land.
    game.addExecution(new FocusTankExecution(defender, tank.id(), 500_000));
    executeTicks(game, 2);
    expect(tank.isActive()).toBe(true);
    expect(tank.health()).toBe(1000);
  });

  test("a nearby tank makes attacks ~15% cheaper and faster, without stacking", async () => {
    await frontGame(UseRealAttackLogic);
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
    const config = game.config();
    const without = config.attackLogic(base);
    const withTank = config.attackLogic({ ...base, attackerHasTank: true });
    expect(withTank.attackerTroopLoss / without.attackerTroopLoss).toBeCloseTo(
      0.85,
    );
    expect(withTank.tickFraction / without.tickFraction).toBeCloseTo(0.85);
  });

  test("an attack next to the attacker's tank loses fewer troops", async () => {
    const lossWith = async (tank: boolean) => {
      await frontGame(UseRealAttackLogic);
      if (tank) buildTank(attacker, 20, 100, 48, 100);
      executeTicks(game, 80);
      const exec = new AttackExecution(
        200_000,
        attacker,
        defender.id(),
        null,
        true,
        [game.ref(70, 100)],
      );
      game.addExecution(exec);
      const tilesBefore = attacker.numTilesOwned();
      executeTicks(game, 40);
      const taken = attacker.numTilesOwned() - tilesBefore;
      const left = attacker.outgoingAttacks()[0]?.troops() ?? 0;
      return (200_000 - left) / Math.max(1, taken);
    };
    const perTileWith = await lossWith(true);
    const perTileWithout = await lossWith(false);
    expect(perTileWith).toBeLessThan(perTileWithout);
  });
});
