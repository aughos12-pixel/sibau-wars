import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";
import { constructionExecution, executeTicks } from "./util/utils";

let game: Game;
let left: Player;
let right: Player;

function addPlayer(id: string, x: number, y: number): Player {
  game.addPlayer(new PlayerInfo(id, PlayerType.Human, null, id));
  game.addExecution(
    new SpawnExecution("g", game.player(id).info(), game.ref(x, y)),
  );
  return game.player(id);
}

/** Two equal halves of the 200x200 plains: left x < 100, right x >= 100. */
async function halves(instantBuild = true) {
  game = await setup(
    "big_plains",
    { infiniteGold: false, instantBuild },
    [],
    undefined,
    UseRealAttackLogic,
  );
  left = addPlayer("left", 50, 100);
  right = addPlayer("right", 150, 100);
  executeTicks(game, 2);
  for (let x = 0; x < 200; x++) {
    for (let y = 0; y < 200; y++) {
      (x < 100 ? left : right).conquer(game.ref(x, y));
    }
  }
}

/** Builds `n` of `type` for `p` in a column (spaced past structureMinDist). */
function build(p: Player, type: UnitType, n: number, x: number) {
  for (let i = 0; i < n; i++) {
    p.addGold(5_000_000n);
    constructionExecution(game, p, x, 10 + i * 20, type);
  }
}

function runToInterval() {
  const every = game.config().bankInterestIntervalTicks();
  // Interest is paid by the tick that starts on a multiple of the interval.
  while (game.ticks() % every !== 0) game.executeNextTick();
}

describe("Schools (Sibau Wars)", () => {
  test("each School adds 2% troop regrowth, up to 5 Schools", async () => {
    await halves();
    const config = game.config();
    left.removeTroops(left.troops() - 10_000);
    const base = config.troopIncreaseRate(left);
    build(left, UnitType.School, 3, 30);
    expect(config.effectiveSchools(left)).toBe(3);
    left.removeTroops(left.troops() - 10_000);
    expect(config.troopIncreaseRate(left) / base).toBeCloseTo(1.06, 5);

    build(left, UnitType.School, 4, 60);
    expect(left.units(UnitType.School)).toHaveLength(7);
    expect(config.effectiveSchools(left)).toBe(5);
    left.removeTroops(left.troops() - 10_000);
    expect(config.troopIncreaseRate(left) / base).toBeCloseTo(1.1, 5);
  });

  test("a School under construction doesn't count yet", async () => {
    await halves(false);
    left.addGold(5_000_000n);
    constructionExecution(game, left, 30, 30, UnitType.School, 3);
    expect(left.units(UnitType.School)[0].isUnderConstruction()).toBe(true);
    expect(game.config().effectiveSchools(left)).toBe(0);
    executeTicks(game, 80);
    expect(game.config().effectiveSchools(left)).toBe(1);
  });

  test("Schools cut the attacker's losses and raise them against the defender", async () => {
    await halves();
    const config = game.config();
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
    const smartAttacker = config.attackLogic({ ...base, attackerSchools: 5 });
    const smartDefender = config.attackLogic({ ...base, defenderSchools: 5 });
    expect(smartAttacker.attackerTroopLoss / plain).toBeCloseTo(0.9);
    expect(smartDefender.attackerTroopLoss / plain).toBeCloseTo(1.1);
  });
});

describe("Banks (Sibau Wars)", () => {
  test("a Bank pays 0.25% of held gold every 10 seconds", async () => {
    await halves();
    build(left, UnitType.Bank, 1, 30);
    left.removeGold(left.gold());
    right.removeGold(right.gold());
    left.addGold(1_000_000n);
    right.addGold(1_000_000n);
    runToInterval();
    const l0 = left.gold();
    const r0 = right.gold();
    game.executeNextTick();
    const interest = left.gold() - l0 - (right.gold() - r0);
    expect(Number(interest)).toBeGreaterThanOrEqual(2_450);
    expect(Number(interest)).toBeLessThanOrEqual(2_550);
  });

  test("interest is capped at 10k per Bank", async () => {
    await halves();
    build(left, UnitType.Bank, 2, 30);
    left.addGold(100_000_000n);
    right.addGold(left.gold() - right.gold());
    runToInterval();
    const l0 = left.gold();
    const r0 = right.gold();
    game.executeNextTick();
    expect(left.gold() - l0 - (right.gold() - r0)).toBe(20_000n);
  });

  test("capturing a Bank steals 15% of the old owner's gold", async () => {
    await halves();
    build(right, UnitType.Bank, 1, 120);
    const bank = right.units(UnitType.Bank)[0];
    right.removeGold(right.gold());
    right.addGold(2_000_000n);
    const before = left.gold();
    left.conquer(bank.tile());
    executeTicks(game, 2);
    expect(bank.owner()).toBe(left);
    const stolen = left.gold() - before;
    // 15% of 2M, give or take two ticks of income.
    expect(Number(stolen)).toBeGreaterThan(299_000);
    expect(Number(stolen)).toBeLessThan(320_000);
    expect(Number(right.gold())).toBeLessThan(1_720_000);
  });

  test("a heist never takes more than 1M", async () => {
    await halves();
    build(right, UnitType.Bank, 1, 120);
    const bank = right.units(UnitType.Bank)[0];
    right.addGold(50_000_000n);
    const before = left.gold();
    left.conquer(bank.tile());
    executeTicks(game, 2);
    const stolen = Number(left.gold() - before);
    expect(stolen).toBeGreaterThanOrEqual(1_000_000);
    expect(stolen).toBeLessThan(1_020_000);
  });
});
