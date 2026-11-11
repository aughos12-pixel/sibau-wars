import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { UserSettings } from "../../UserSettings";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/**
 * Sibau Wars: General Albin, the in-game advisor.
 *
 * Albin's picture is resources/images/albin.png. To use your own, replace
 * that file with a square picture of the same name (see README).
 */
const ALBIN_PICTURE = assetUrl("images/albin.png");

/** Game ticks (10 per second). */
const TIP_COOLDOWN_TICKS = 300; // at most one tip every 30 s
const TIP_SHOW_TICKS = 90; // a tip stays up for 9 s
const TROOPS_FULL_TICKS = 200; // troops must sit full for 20 s
const SCHOOL_TIP_AFTER_TICKS = 3000; // 5 minutes into the game

type TipId =
  | "enemy_tank"
  | "heavy_attack"
  | "losing_attack"
  | "build_bank"
  | "spend_gold"
  | "troops_full"
  | "build_school"
  | "send_tank"
  | "precise_attacks";

/** How many times each tip may show in one game. */
const MAX_SHOWS: Record<TipId, number> = {
  enemy_tank: 3,
  heavy_attack: 2,
  losing_attack: 2,
  build_bank: 2,
  spend_gold: 1,
  troops_full: 2,
  build_school: 1,
  send_tank: 1,
  precise_attacks: 1,
};

/** Message keys, written out so the translation check can find them. */
const TIP_TEXT: Record<TipId, string> = {
  enemy_tank: "albin.tip_enemy_tank",
  heavy_attack: "albin.tip_heavy_attack",
  losing_attack: "albin.tip_losing_attack",
  build_bank: "albin.tip_build_bank",
  spend_gold: "albin.tip_spend_gold",
  troops_full: "albin.tip_troops_full",
  build_school: "albin.tip_build_school",
  send_tank: "albin.tip_send_tank",
  precise_attacks: "albin.tip_precise_attacks",
};

@customElement("albin-advisor")
export class AlbinAdvisor extends LitElement implements Controller {
  public game: GameView;

  @state() private tip: TipId | null = null;
  @state() private pictureMissing = false;
  /** Albin sits in the corner as a small portrait whenever this is true. */
  @state() private active = false;
  /** Opened by clicking the portrait: shows the last tip again. */
  @state() private peeking = false;
  private lastTip: TipId | null = null;

  private enabled = true;
  private tipShownAt = -Infinity;
  private shows = new Map<TipId, number>();
  /** Troops each of our attacks started with, by attack id. */
  private attackStart = new Map<string, number>();
  private troopsFullSince: number | null = null;
  private firstTick: number | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.enabled = new UserSettings().albinAdvisor();
  }

  private refreshEnabled() {
    // Read each time so switching it in Settings works mid-game.
    this.enabled = new UserSettings().albinAdvisor();
    if (!this.enabled) {
      this.tip = null;
      this.active = false;
      this.peeking = false;
    }
  }

  getTickIntervalMs() {
    return 1000;
  }

  tick() {
    const game = this.game;
    this.refreshEnabled();
    if (!this.enabled || game === undefined) return;
    if (game.config().gameConfig().tutorial) return;
    const me = game.myPlayer();
    if (me === null || !me.isAlive() || game.inSpawnPhase()) {
      this.tip = null;
      this.active = false;
      this.peeking = false;
      return;
    }
    this.active = true;
    const now = game.ticks();
    this.firstTick ??= now;

    if (this.tip !== null && now - this.tipShownAt >= TIP_SHOW_TICKS) {
      this.tip = null;
    }
    const next = this.findTip(me, now);
    if (next === null || now - this.tipShownAt < TIP_COOLDOWN_TICKS) return;
    this.shows.set(next, (this.shows.get(next) ?? 0) + 1);
    this.tip = next;
    this.lastTip = next;
    this.peeking = false;
    this.tipShownAt = now;
  }

  private canShow(id: TipId): boolean {
    return (this.shows.get(id) ?? 0) < MAX_SHOWS[id];
  }

  private unitOn(type: UnitType): boolean {
    return !this.game.config().isUnitDisabled(type);
  }

  /** The most urgent tip that applies right now, if any. */
  private findTip(me: PlayerView, now: number): TipId | null {
    const game = this.game;
    const tips: [TipId, () => boolean][] = [
      [
        "enemy_tank",
        () =>
          game
            .units(UnitType.Tank)
            .some(
              (t) =>
                t.isActive() &&
                t.owner() !== me &&
                !t.owner().isFriendly(me) &&
                game.owner(t.tile()) === me,
            ),
      ],
      [
        "heavy_attack",
        () =>
          me.incomingAttacks().reduce((sum, a) => sum + a.troops, 0) >
          me.troops() * 0.6,
      ],
      ["losing_attack", () => this.attackIsFailing(me)],
      [
        "build_bank",
        () =>
          this.unitOn(UnitType.Bank) &&
          me.gold() > 1_000_000n &&
          me.units(UnitType.Bank).length === 0,
      ],
      ["spend_gold", () => me.gold() > 5_000_000n],
      ["troops_full", () => this.troopsFull(me, now)],
      [
        "build_school",
        () =>
          this.unitOn(UnitType.School) &&
          now - (this.firstTick ?? now) > SCHOOL_TIP_AFTER_TICKS &&
          me.units(UnitType.City).length >= 3 &&
          me.units(UnitType.School).length === 0,
      ],
      [
        "send_tank",
        () =>
          this.unitOn(UnitType.Tank) &&
          me
            .units(UnitType.Barracks)
            .some((b) => b.isActive() && !b.isUnderConstruction()) &&
          me.units(UnitType.Tank).length === 0,
      ],
      [
        "precise_attacks",
        () =>
          new UserSettings().preciseAttacks() &&
          me.outgoingAttacks().some((a) => a.targetID !== 0),
      ],
    ];
    // Keep the per-attack bookkeeping current even while on cooldown.
    this.trackAttacks(me);
    for (const [id, applies] of tips) {
      if (this.canShow(id) && applies()) return id;
    }
    return null;
  }

  private trackAttacks(me: PlayerView) {
    const live = new Set<string>();
    for (const a of me.outgoingAttacks()) {
      live.add(a.id);
      if (!this.attackStart.has(a.id)) this.attackStart.set(a.id, a.troops);
    }
    for (const id of this.attackStart.keys()) {
      if (!live.has(id)) this.attackStart.delete(id);
    }
  }

  private attackIsFailing(me: PlayerView): boolean {
    return me.outgoingAttacks().some((a) => {
      const start = this.attackStart.get(a.id) ?? a.troops;
      return (
        !a.retreating &&
        a.targetID !== 0 &&
        start > 1000 &&
        a.troops < start / 4
      );
    });
  }

  private troopsFull(me: PlayerView, now: number): boolean {
    const full = me.troops() >= this.game.config().maxTroops(me) * 0.95;
    if (!full) {
      this.troopsFullSince = null;
      return false;
    }
    this.troopsFullSince ??= now;
    return now - this.troopsFullSince >= TROOPS_FULL_TICKS;
  }

  private dismiss = () => {
    this.tip = null;
    this.peeking = false;
  };

  private togglePeek = () => {
    this.peeking = !this.peeking;
  };

  private portrait(sizeClass: string) {
    return this.pictureMissing
      ? html`<div
          class="flex ${sizeClass} shrink-0 items-center justify-center rounded-lg bg-malibu-blue text-2xl font-bold"
        >
          A
        </div>`
      : html`<img
          src=${ALBIN_PICTURE}
          alt=""
          class="${sizeClass} shrink-0 rounded-lg object-cover"
          draggable="false"
          @error=${() => {
            this.pictureMissing = true;
          }}
        />`;
  }

  render() {
    if (!this.active) return nothing;
    const text =
      this.tip !== null
        ? translateText(TIP_TEXT[this.tip])
        : this.peeking
          ? this.lastTip !== null
            ? translateText(TIP_TEXT[this.lastTip])
            : translateText("albin.no_advice")
          : null;

    // No tip: just his portrait in the corner. Click it to hear the last tip.
    if (text === null) {
      return html`
        <button
          type="button"
          class="albin-advisor albin-portrait fixed left-3 bottom-40 z-[45] rounded-xl border border-malibu-blue/70 bg-surface/95 p-1 shadow-lg hover:border-sky-300"
          title=${translateText("albin.title")}
          aria-label=${translateText("albin.title")}
          @click=${this.togglePeek}
        >
          ${this.portrait("size-12")}
        </button>
      `;
    }

    return html`
      <div
        class="albin-advisor albin-tip fixed left-3 bottom-40 z-[45] flex max-w-[340px] items-start gap-3 rounded-xl border border-malibu-blue/70 bg-surface/95 p-3 text-white shadow-lg"
        role="status"
        aria-live="polite"
      >
        ${this.portrait("size-14")}
        <div class="min-w-0 flex-1">
          <div class="text-xs font-bold uppercase tracking-widest text-sky-300">
            ${translateText("albin.title")}
          </div>
          <p class="mt-0.5 text-sm leading-snug">${text}</p>
        </div>
        <button
          type="button"
          class="-mr-1 -mt-1 shrink-0 px-1 text-lg leading-none text-white/60 hover:text-white"
          aria-label=${translateText("albin.close")}
          @click=${this.dismiss}
        >
          ×
        </button>
      </div>
    `;
  }
}
