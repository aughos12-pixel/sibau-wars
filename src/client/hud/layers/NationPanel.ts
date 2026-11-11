import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  GOVERNMENTS,
  Government,
  hasTechInMask,
  Tech,
  TechBranch,
  TECHS,
  techPrerequisite,
} from "@openfront/engine-api/game/Sibau";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  SendCancelVassalIntentEvent,
  SendResearchIntentEvent,
  SendSetGovernmentIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/**
 * Sibau Wars: the Nation panel — pick a government once, research techs,
 * and see your capital, war exhaustion, vassals and oil.
 *
 * Keys are written out in full so the translation check can find them.
 */
const GOVERNMENT_TEXT: Record<Government, { name: string; desc: string }> = {
  [Government.Monarchy]: {
    name: "nation.gov_monarchy",
    desc: "nation.gov_monarchy_desc",
  },
  [Government.Republic]: {
    name: "nation.gov_republic",
    desc: "nation.gov_republic_desc",
  },
  [Government.Junta]: {
    name: "nation.gov_junta",
    desc: "nation.gov_junta_desc",
  },
  [Government.Theocracy]: {
    name: "nation.gov_theocracy",
    desc: "nation.gov_theocracy_desc",
  },
};

const GOVERNMENT_ICON: Record<Government, string> = {
  [Government.Monarchy]: "👑",
  [Government.Republic]: "🏛️",
  [Government.Junta]: "🎖️",
  [Government.Theocracy]: "⛪",
};

const TECH_TEXT: Record<Tech, { name: string; desc: string }> = {
  [Tech.TradeRoutes]: {
    name: "nation.tech_trade_routes",
    desc: "nation.tech_trade_routes_desc",
  },
  [Tech.Banking]: {
    name: "nation.tech_banking",
    desc: "nation.tech_banking_desc",
  },
  [Tech.Industry]: {
    name: "nation.tech_industry",
    desc: "nation.tech_industry_desc",
  },
  [Tech.Drill]: { name: "nation.tech_drill", desc: "nation.tech_drill_desc" },
  [Tech.Armor]: { name: "nation.tech_armor", desc: "nation.tech_armor_desc" },
  [Tech.Blitz]: { name: "nation.tech_blitz", desc: "nation.tech_blitz_desc" },
  [Tech.Fortify]: {
    name: "nation.tech_fortify",
    desc: "nation.tech_fortify_desc",
  },
  [Tech.Militia]: {
    name: "nation.tech_militia",
    desc: "nation.tech_militia_desc",
  },
  [Tech.Bunkers]: {
    name: "nation.tech_bunkers",
    desc: "nation.tech_bunkers_desc",
  },
};

const BRANCH_TEXT: Record<TechBranch, string> = {
  [TechBranch.Economy]: "nation.branch_economy",
  [TechBranch.Military]: "nation.branch_military",
  [TechBranch.Defense]: "nation.branch_defense",
};

const BRANCHES: TechBranch[] = [
  TechBranch.Economy,
  TechBranch.Military,
  TechBranch.Defense,
];

type TechState = "learned" | "ready" | "need_points" | "locked";

@customElement("nation-panel")
export class NationPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private open = false;
  /** Bumped every tick so the panel re-renders with fresh numbers. */
  @state() private revision = 0;
  /** Government we just asked for, until the engine confirms it. */
  @state() private pendingGovernment: Government | null = null;

  createRenderRoot() {
    return this;
  }

  init() {}

  getTickIntervalMs() {
    return 500;
  }

  tick() {
    this.revision++;
    const me = this.me();
    if (me?.sibau().government !== null) this.pendingGovernment = null;
  }

  private me(): PlayerView | null {
    const me = this.game?.myPlayer() ?? null;
    if (me === null || !me.isAlive() || !me.hasSpawned()) return null;
    return me;
  }

  private pickGovernment(g: Government) {
    this.pendingGovernment = g;
    this.eventBus.emit(new SendSetGovernmentIntentEvent(g));
  }

  private cancelVassal(partner: PlayerView) {
    this.eventBus.emit(new SendCancelVassalIntentEvent(partner.id()));
  }

  private research(tech: Tech) {
    this.eventBus.emit(new SendResearchIntentEvent(tech));
  }

  private techState(me: PlayerView, tech: Tech, cost: number): TechState {
    const s = me.sibau();
    if (hasTechInMask(s.techs, tech)) return "learned";
    const prev = techPrerequisite(tech);
    if (prev !== null && !hasTechInMask(s.techs, prev)) return "locked";
    return s.research >= cost ? "ready" : "need_points";
  }

  render() {
    void this.revision;
    const me = this.me();
    if (me === null || this.game.config().gameConfig().tutorial) return nothing;
    const s = me.sibau();
    const choosing = s.government === null && this.pendingGovernment === null;
    return html`
      ${choosing ? this.renderGovernmentPicker() : nothing}
      <button
        class="nation-panel-button fixed left-3 top-1/2 z-[44] -translate-y-1/2 rounded-lg border border-malibu-blue/70 bg-surface/95 px-2 py-2 text-xs font-bold text-white shadow-lg hover:bg-malibu-blue/40"
        @click=${() => (this.open = !this.open)}
        title=${translateText("nation.open")}
      >
        <div class="text-lg leading-none">
          ${s.government !== null ? GOVERNMENT_ICON[s.government] : "🏛️"}
        </div>
        <div class="mt-1">${translateText("nation.button")}</div>
        ${
          this.readyTechCount(me) > 0
            ? html`<div
                class="mt-1 rounded bg-emerald-500 px-1 text-[10px] text-white"
              >
                ${translateText("nation.ready_count", {
                  count: this.readyTechCount(me),
                })}
              </div>`
            : nothing
        }
      </button>
      ${this.open ? this.renderPanel(me) : nothing}
    `;
  }

  private readyTechCount(me: PlayerView): number {
    return TECHS.filter((t) => this.techState(me, t.tech, t.cost) === "ready")
      .length;
  }

  private renderGovernmentPicker() {
    return html`
      <div
        class="nation-government-picker fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      >
        <div
          class="w-full max-w-2xl rounded-xl border border-malibu-blue/70 bg-surface p-5 text-white shadow-2xl"
        >
          <h2 class="text-xl font-bold">
            ${translateText("nation.pick_government")}
          </h2>
          <p class="mt-1 text-sm text-white/70">
            ${translateText("nation.pick_government_desc")}
          </p>
          <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            ${GOVERNMENTS.map(
              (g) => html`
                <button
                  class="nation-gov-option rounded-lg border border-white/20 bg-white/5 p-3 text-left hover:border-malibu-blue hover:bg-malibu-blue/30"
                  data-government=${g}
                  @click=${() => this.pickGovernment(g)}
                >
                  <div class="text-lg font-bold">
                    ${GOVERNMENT_ICON[g]}
                    ${translateText(GOVERNMENT_TEXT[g].name)}
                  </div>
                  <div class="mt-1 text-sm text-white/80">
                    ${translateText(GOVERNMENT_TEXT[g].desc)}
                  </div>
                </button>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  private renderPanel(me: PlayerView) {
    const s = me.sibau();
    const config = this.game.config();
    const vassals = this.game
      .playerViews()
      .filter((p) => p.isAlive() && p.sibau().overlordID === me.smallID());
    const overlord = me.overlord();
    const drills = me
      .units(UnitType.OilDrill)
      .filter((u) => !u.isUnderConstruction()).length;
    const capitalText = s.capitalLost
      ? translateText("nation.capital_lost")
      : s.capitalUnitID !== null
        ? translateText("nation.capital_ok")
        : translateText("nation.capital_none");

    return html`
      <div
        class="nation-panel fixed left-20 top-16 z-[1000] max-h-[calc(100vh-15rem)] w-[min(640px,calc(100vw-6rem))] overflow-y-auto rounded-xl border border-malibu-blue/70 bg-surface/95 p-4 text-white shadow-2xl"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <div
              class="text-xs font-bold uppercase tracking-widest text-sky-300"
            >
              ${translateText("nation.title")}
            </div>
            <div class="text-lg font-bold">
              ${
                s.government !== null
                  ? html`${GOVERNMENT_ICON[s.government]}
                    ${translateText(GOVERNMENT_TEXT[s.government].name)}`
                  : translateText("nation.no_government")
              }
            </div>
            ${
              s.government !== null
                ? html`<div class="text-sm text-white/70">
                    ${translateText(GOVERNMENT_TEXT[s.government].desc)}
                  </div>`
                : nothing
            }
          </div>
          <button
            class="px-1 text-xl leading-none text-white/60 hover:text-white"
            @click=${() => (this.open = false)}
            aria-label=${translateText("nation.close")}
          >
            ×
          </button>
        </div>

        <div class="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          ${this.stat(translateText("nation.capital"), capitalText, s.capitalLost)}
          ${this.stat(
            translateText("nation.exhaustion"),
            `${s.exhaustion}%`,
            s.exhaustion >= 50,
          )}
          ${this.stat(translateText("nation.oil_drills"), String(drills), false)}
          ${this.stat(
            translateText("nation.research"),
            translateText("nation.research_value", {
              points: s.research,
              rate: config.researchPerTenSeconds(me),
            }),
            false,
          )}
        </div>

        ${
          overlord !== null
            ? html`<div class="mt-2 flex flex-wrap items-center gap-2">
                <p class="text-sm text-amber-300">
                  ${translateText("nation.you_are_vassal", {
                    name: overlord.displayName(),
                  })}
                </p>
                <button
                  class="nation-break-free rounded-md bg-red-700 px-2 py-1 text-xs font-bold hover:bg-red-600"
                  @click=${() => this.cancelVassal(overlord)}
                >
                  ${translateText("nation.break_free")}
                </button>
              </div>`
            : nothing
        }
        ${
          vassals.length > 0
            ? html`<div class="mt-2 text-sm text-emerald-300">
                ${translateText("nation.your_vassals_label")}
                <div class="mt-1 flex flex-wrap gap-2">
                  ${vassals.map(
                    (v) =>
                      html`<span
                        class="flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-white"
                      >
                        ${v.displayName()}
                        <button
                          class="nation-release rounded bg-red-700 px-1.5 text-[11px] font-bold hover:bg-red-600"
                          @click=${() => this.cancelVassal(v)}
                        >
                          ${translateText("nation.release")}
                        </button>
                      </span>`,
                  )}
                </div>
              </div>`
            : nothing
        }

        <h3 class="mt-4 text-sm font-bold uppercase tracking-wide text-sky-300">
          ${translateText("nation.tech_tree")}
        </h3>
        <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          ${BRANCHES.map(
            (branch) => html`
              <div>
                <div class="mb-1 text-xs font-bold uppercase text-white/60">
                  ${translateText(BRANCH_TEXT[branch])}
                </div>
                <div class="flex flex-col gap-2">
                  ${TECHS.filter((t) => t.branch === branch).map((t) =>
                    this.renderTech(me, t.tech, t.cost),
                  )}
                </div>
              </div>
            `,
          )}
        </div>

        <p class="mt-4 text-xs text-white/60">
          ${translateText("nation.oil_hint", {
            cost: renderNumber(5_000_000),
          })}
        </p>
        <p class="mt-1 text-xs text-white/60">
          ${translateText("nation.vassal_hint")}
        </p>
      </div>
    `;
  }

  private stat(label: string, value: string, bad: boolean) {
    return html`<div class="rounded-lg bg-white/5 px-2 py-1">
      <div class="text-[10px] uppercase text-white/50">${label}</div>
      <div class=${bad ? "font-bold text-red-400" : "font-bold"}>${value}</div>
    </div>`;
  }

  private renderTech(me: PlayerView, tech: Tech, cost: number) {
    const st = this.techState(me, tech, cost);
    const styles: Record<TechState, string> = {
      learned: "border-emerald-400 bg-emerald-500/20",
      ready: "border-malibu-blue bg-malibu-blue/30 hover:bg-malibu-blue/50",
      need_points: "border-white/20 bg-white/5",
      locked: "border-white/10 bg-black/20 opacity-50",
    };
    const label: Record<TechState, string> = {
      learned: translateText("nation.tech_learned"),
      ready: translateText("nation.tech_research", { cost }),
      need_points: translateText("nation.tech_cost", { cost }),
      locked: translateText("nation.tech_locked"),
    };
    return html`
      <button
        class="nation-tech rounded-lg border p-2 text-left ${styles[st]}"
        data-tech=${tech}
        data-state=${st}
        ?disabled=${st !== "ready"}
        @click=${() => this.research(tech)}
      >
        <div class="text-sm font-bold">
          ${translateText(TECH_TEXT[tech].name)}
        </div>
        <div class="text-xs text-white/75">
          ${translateText(TECH_TEXT[tech].desc)}
        </div>
        <div class="mt-1 text-[11px] font-bold text-sky-200">${label[st]}</div>
      </button>
    `;
  }
}
