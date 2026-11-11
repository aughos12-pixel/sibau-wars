import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { AlbinAdvisor } from "../../src/client/hud/layers/AlbinAdvisor";
import { UserSettings } from "../../src/client/UserSettings";

type FakeUnit = {
  type: () => UnitType;
  owner: () => unknown;
  tile: () => number;
  isActive: () => boolean;
  isUnderConstruction: () => boolean;
};

function setup(opts: { gold?: bigint; enemyTankOnMyLand?: boolean } = {}) {
  let ticks = 1000;
  const enemy = { isFriendly: () => false };
  const me: Record<string, unknown> = {
    isAlive: () => true,
    gold: () => opts.gold ?? 0n,
    troops: () => 10_000,
    incomingAttacks: () => [],
    outgoingAttacks: () => [],
    units: () => [],
  };
  const units: FakeUnit[] = opts.enemyTankOnMyLand
    ? [
        {
          type: () => UnitType.Tank,
          owner: () => enemy,
          tile: () => 7,
          isActive: () => true,
          isUnderConstruction: () => false,
        },
      ]
    : [];
  const game = {
    config: () => ({
      gameConfig: () => ({ tutorial: false }),
      isUnitDisabled: () => false,
      maxTroops: () => 1_000_000,
    }),
    myPlayer: () => me,
    inSpawnPhase: () => false,
    ticks: () => ticks,
    units: (type: UnitType) => units.filter((u) => u.type() === type),
    owner: (tile: number) => (tile === 7 ? me : enemy),
  };
  const advisor = new AlbinAdvisor();
  (advisor as unknown as { game: unknown }).game = game;
  document.body.appendChild(advisor);
  advisor.init();
  return {
    advisor,
    advance: (n: number) => {
      ticks += n;
    },
    tip: () => (advisor as unknown as { tip: string | null }).tip,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("General Albin (Sibau Wars)", () => {
  test("warns about an enemy tank in your land", async () => {
    const { advisor, tip } = setup({ enemyTankOnMyLand: true });
    advisor.tick();
    expect(tip()).toBe("enemy_tank");
    await advisor.updateComplete;
    expect(advisor.textContent).toContain("albin.title");
    expect(advisor.querySelector("img")?.getAttribute("src")).toContain(
      "images/albin.png",
    );
  });

  test("says nothing when nothing is going on", () => {
    const { advisor, tip } = setup();
    advisor.tick();
    expect(tip()).toBeNull();
  });

  test("waits 30 seconds between tips and repeats a tip only a few times", () => {
    const { advisor, tip, advance } = setup({ gold: 2_000_000n });
    advisor.tick();
    expect(tip()).toBe("build_bank");
    advance(100); // 10 s: still on cooldown, tip hides after 9 s
    advisor.tick();
    expect(tip()).toBeNull();
    advance(250); // past the 30 s cooldown
    advisor.tick();
    expect(tip()).toBe("build_bank");
    advance(400);
    advisor.tick();
    // The Bank tip has had its two showings.
    expect(tip()).not.toBe("build_bank");
  });

  test("can be switched off in Settings", async () => {
    const settings = new UserSettings();
    settings.toggleAlbinAdvisor();
    try {
      expect(settings.albinAdvisor()).toBe(false);
      const { advisor, tip } = setup({ enemyTankOnMyLand: true });
      advisor.tick();
      expect(tip()).toBeNull();
      await advisor.updateComplete;
      // Not even the portrait.
      expect(advisor.querySelector(".albin-advisor")).toBeNull();
    } finally {
      settings.toggleAlbinAdvisor();
    }
  });

  test("always sits in the corner as a small portrait", async () => {
    const { advisor, tip } = setup();
    advisor.tick();
    expect(tip()).toBeNull();
    await advisor.updateComplete;
    expect(advisor.querySelector(".albin-portrait")).not.toBeNull();
    expect(advisor.querySelector(".albin-tip")).toBeNull();
    expect(advisor.querySelector("img")?.getAttribute("src")).toContain(
      "images/albin.png",
    );
  });

  test("clicking the portrait repeats his last tip", async () => {
    const { advisor, tip, advance } = setup({ gold: 2_000_000n });
    advisor.tick();
    expect(tip()).toBe("build_bank");
    advance(100); // the tip hides after 9 s
    advisor.tick();
    await advisor.updateComplete;
    const portrait =
      advisor.querySelector<HTMLButtonElement>(".albin-portrait");
    expect(portrait).not.toBeNull();
    portrait!.click();
    await advisor.updateComplete;
    expect(advisor.querySelector(".albin-tip")?.textContent).toContain(
      "albin.tip_build_bank",
    );
  });
});
