import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  TerrainType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

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
async function frontGame() {
  game = await setup("big_plains", { infiniteGold: true, instantBuild: true });
  attacker = addPlayer("attacker", 20, 100);
  defender = addPlayer("defender", 120, 100);
  executeTicks(game, 2);
  for (let x = 0; x < 200; x++) {
    for (let y = 0; y < 200; y++) {
      (x < 50 ? attacker : defender).conquer(game.ref(x, y));
    }
  }
  attacker.addTroops(2_000_000);
  defender.addTroops(50_000);
}

function attackerTilesIn(x0: number, x1: number, y0: number, y1: number) {
  let n = 0;
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      if (game.owner(game.ref(x, y)) === attacker) n++;
    }
  }
  return n;
}

function launch(path: TileRef[] | null) {
  game.addExecution(
    new AttackExecution(400_000, attacker, defender.id(), null, true, path),
  );
}

describe("precise attacks (Sibau Wars)", () => {
  test("a spearhead pushes toward the clicked point instead of the whole border", async () => {
    await frontGame();
    launch([game.ref(80, 20)]);
    executeTicks(game, 60);

    const nearAim = attackerTilesIn(50, 120, 0, 50);
    const farSide = attackerTilesIn(50, 120, 120, 200);
    // The test config takes one tile per tick.
    expect(nearAim).toBeGreaterThan(40);
    expect(farSide).toBe(0);
  });

  test("a classic attack spreads along the whole border", async () => {
    await frontGame();
    launch(null);
    executeTicks(game, 60);

    expect(attackerTilesIn(50, 120, 0, 50)).toBeGreaterThan(0);
    expect(attackerTilesIn(50, 120, 120, 200)).toBeGreaterThan(0);
  });

  test("a route is followed in order, around to its last point", async () => {
    await frontGame();
    // Down the defender's side: top, then middle, then bottom.
    launch([game.ref(58, 20), game.ref(62, 100), game.ref(58, 180)]);
    executeTicks(game, 600);

    expect(attackerTilesIn(55, 62, 15, 25)).toBeGreaterThan(0);
    expect(attackerTilesIn(59, 66, 95, 105)).toBeGreaterThan(0);
    expect(attackerTilesIn(55, 62, 175, 185)).toBeGreaterThan(0);
  });

  test("route points on your own side are skipped", async () => {
    await frontGame();
    // The first point is deep in the attacker's own land.
    launch([game.ref(10, 10), game.ref(80, 150)]);
    executeTicks(game, 60);
    expect(attackerTilesIn(50, 120, 110, 200)).toBeGreaterThan(30);
    expect(attackerTilesIn(50, 120, 0, 40)).toBe(0);
  });

  test("troops come home soon after the last point is reached", async () => {
    // Regression: they used to wait ~60 s for the corridor to reach full
    // width before going home, and looked lost.
    game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [],
      undefined,
      UseRealAttackLogic,
    );
    attacker = addPlayer("attacker", 20, 100);
    defender = addPlayer("defender", 120, 100);
    executeTicks(game, 2);
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) {
        (x < 50 ? attacker : defender).conquer(game.ref(x, y));
      }
    }
    attacker.addTroops(500_000);
    defender.addTroops(50_000);
    const aim = game.ref(70, 100);
    launch([aim]);
    executeTicks(game, 1);
    let ticks = 0;
    let before = attacker.troops();
    let returned = 0;
    while (attacker.outgoingAttacks().length > 0 && ticks < 600) {
      before = attacker.troops();
      executeTicks(game, 1);
      ticks++;
      if (attacker.outgoingAttacks().length === 0) {
        returned = attacker.troops() - before;
      }
    }
    expect(game.owner(aim)).toBe(attacker);
    // Home within 10 s (it was over a minute)...
    expect(ticks).toBeLessThan(100);
    // ...with the survivors.
    expect(returned).toBeGreaterThan(100_000);
  });

  test("an attack isn't sent home before it reaches its last point", async () => {
    await frontGame();
    launch([game.ref(150, 100)]);
    // The test config takes one tile per tick: 100 tiles away is far off.
    executeTicks(game, 30);
    expect(game.owner(game.ref(150, 100))).toBe(defender);
    expect(attacker.outgoingAttacks()).toHaveLength(1);
  });

  test("precise attacks are never merged with other attacks", async () => {
    await frontGame();
    launch(null);
    game.executeNextTick();
    launch([game.ref(80, 20)]);
    game.executeNextTick();
    launch(null);
    game.executeNextTick();

    const outgoing = attacker.outgoingAttacks();
    expect(outgoing.filter((a) => a.isDirectional())).toHaveLength(1);
    // The two classic attacks merged as before.
    expect(outgoing.filter((a) => !a.isDirectional())).toHaveLength(1);
  });

  test("a precise attack on a player you don't border doesn't happen", async () => {
    await frontGame();
    const before = attacker.troops();
    const stranger = addPlayer("stranger", 190, 190);
    executeTicks(game, 2);
    game.addExecution(
      new AttackExecution(100_000, attacker, stranger.id(), null, true, [
        game.ref(190, 190),
      ]),
    );
    executeTicks(game, 3);
    expect(attacker.outgoingAttacks()).toHaveLength(0);
    void before;
  });

  test("a precise attack pays 25% more troops per tile", async () => {
    const game = await setup(
      "big_plains",
      {},
      [],
      undefined,
      UseRealAttackLogic,
    );
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
    const classic = game.config().attackLogic(base);
    const precise = game.config().attackLogic({ ...base, preciseAttack: true });
    expect(precise.attackerTroopLoss / classic.attackerTroopLoss).toBeCloseTo(
      1.25,
    );
    expect(precise.tickFraction).toBeCloseTo(classic.tickFraction);
  });
});
