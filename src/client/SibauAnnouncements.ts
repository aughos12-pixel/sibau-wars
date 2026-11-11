import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "./Utils";

/**
 * Sibau Wars: admin announcements.
 *
 * <sibau-announcement> asks the server for the latest announcement every few
 * seconds and shows a new one as a banner — on the homepage and in games.
 *
 * <sibau-admin-panel> is the owner's panel. It opens when the address ends
 * with #admin and needs the server's admin password (SIBAU_ADMIN_PASSWORD).
 * The password is remembered on this computer after it works once.
 *
 * Kept small and free of game-client imports: Main.ts loads it on the
 * homepage.
 */

const ANNOUNCEMENT_URL = "/api/sibau/announcement";
const POLL_MS = 10_000;
const SHOW_MS = 15_000;
const ADMIN_HEADER = "x-sibau-admin";
const PASSWORD_KEY = "sibau.adminPassword";
const SEEN_KEY = "sibau.lastAnnouncement";
const MAX_LENGTH = 300;

interface Announcement {
  id: number;
  message: string;
  sentAt: number;
}

function readStorage(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(store: Storage, key: string, value: string | null) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage can be off (private mode); then we just don't remember.
  }
}

@customElement("sibau-announcement")
export class SibauAnnouncement extends LitElement {
  @state() private shown: Announcement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer !== null) clearInterval(this.timer);
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
  }

  /** Shows `a` unless this browser already showed it. */
  showIfNew(a: Announcement | null) {
    if (a === null) return;
    // Ids restart from 1 when the server restarts, so key on time too.
    const key = `${a.id}:${a.sentAt}`;
    if (readStorage(sessionStorage, SEEN_KEY) === key) return;
    writeStorage(sessionStorage, SEEN_KEY, key);
    this.shown = a;
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => (this.shown = null), SHOW_MS);
  }

  private async poll() {
    if (document.visibilityState === "hidden") return;
    try {
      const res = await fetch(ANNOUNCEMENT_URL, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { announcement?: Announcement | null };
      this.showIfNew(body.announcement ?? null);
    } catch {
      // Offline or server restarting: try again next time.
    }
  }

  render() {
    if (this.shown === null) return nothing;
    return html`
      <div
        class="sibau-announcement fixed left-1/2 top-4 z-[10000] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border-2 border-sky-300 bg-blue-900/95 px-5 py-3 text-white shadow-2xl"
        role="alert"
      >
        <div class="flex items-start gap-3">
          <div class="text-2xl leading-none">📢</div>
          <div class="min-w-0 flex-1">
            <div
              class="text-xs font-bold uppercase tracking-widest text-sky-300"
            >
              ${translateText("sibau_admin.announcement")}
            </div>
            <p
              class="mt-1 whitespace-pre-wrap break-words text-base font-semibold"
              .textContent=${this.shown.message}
            ></p>
          </div>
          <button
            type="button"
            class="-mr-1 -mt-1 px-1 text-xl leading-none text-white/70 hover:text-white"
            aria-label=${translateText("sibau_admin.close")}
            @click=${() => (this.shown = null)}
          >
            ×
          </button>
        </div>
      </div>
    `;
  }
}

type PanelStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; key: string }
  | { kind: "error"; key: string };

@customElement("sibau-admin-panel")
export class SibauAdminPanel extends LitElement {
  @state() private open = false;
  @state() private loggedIn = false;
  @state() private password = "";
  @state() private message = "";
  @state() private status: PanelStatus = { kind: "idle" };

  createRenderRoot() {
    return this;
  }

  private onHash = () => this.syncWithHash();

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", this.onHash);
    this.syncWithHash();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onHash);
  }

  private syncWithHash() {
    const wantOpen = window.location.hash === "#admin";
    if (wantOpen && !this.open) {
      this.open = true;
      const saved = readStorage(localStorage, PASSWORD_KEY);
      if (saved !== null) {
        this.password = saved;
        void this.login(true);
      }
    } else if (!wantOpen) {
      this.open = false;
    }
  }

  private close() {
    this.open = false;
    if (window.location.hash === "#admin") {
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }

  private async request(path: string, body: unknown): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ADMIN_HEADER]: this.password,
      },
      body: JSON.stringify(body),
    });
  }

  private errorFor(status: number): string {
    if (status === 401) return "sibau_admin.wrong_password";
    if (status === 429) return "sibau_admin.locked";
    if (status === 404) return "sibau_admin.not_set_up";
    return "sibau_admin.failed";
  }

  private async login(silent = false) {
    if (this.password.length === 0) return;
    this.status = { kind: "busy" };
    try {
      const res = await this.request("/api/sibau/admin/login", {});
      if (res.ok) {
        this.loggedIn = true;
        writeStorage(localStorage, PASSWORD_KEY, this.password);
        this.status = { kind: "idle" };
        return;
      }
      this.loggedIn = false;
      if (res.status === 401) writeStorage(localStorage, PASSWORD_KEY, null);
      this.status = silent
        ? { kind: "idle" }
        : { kind: "error", key: this.errorFor(res.status) };
    } catch {
      this.status = { kind: "error", key: "sibau_admin.failed" };
    }
  }

  private logout() {
    writeStorage(localStorage, PASSWORD_KEY, null);
    this.loggedIn = false;
    this.password = "";
    this.status = { kind: "idle" };
  }

  private async announce() {
    const message = this.message.trim();
    if (message.length === 0) return;
    this.status = { kind: "busy" };
    try {
      const res = await this.request("/api/sibau/admin/announce", { message });
      if (res.ok) {
        this.message = "";
        this.status = { kind: "ok", key: "sibau_admin.sent" };
        return;
      }
      if (res.status === 401) this.loggedIn = false;
      this.status = { kind: "error", key: this.errorFor(res.status) };
    } catch {
      this.status = { kind: "error", key: "sibau_admin.failed" };
    }
  }

  private renderStatus() {
    const s = this.status;
    if (s.kind === "idle") return nothing;
    if (s.kind === "busy") {
      return html`<p class="mt-2 text-sm text-white/70">
        ${translateText("sibau_admin.working")}
      </p>`;
    }
    return html`<p
      class="sibau-admin-status mt-2 text-sm ${
        s.kind === "ok" ? "text-emerald-300" : "text-red-300"
      }"
    >
      ${translateText(s.key)}
    </p>`;
  }

  render() {
    if (!this.open) return nothing;
    const busy = this.status.kind === "busy";
    return html`
      <div
        class="sibau-admin-panel fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4"
      >
        <div
          class="w-full max-w-lg rounded-xl border border-malibu-blue/70 bg-surface p-5 text-white shadow-2xl"
        >
          <div class="flex items-start justify-between">
            <h2 class="text-xl font-bold">
              ${translateText("sibau_admin.title")}
            </h2>
            <button
              type="button"
              class="px-1 text-xl leading-none text-white/60 hover:text-white"
              aria-label=${translateText("sibau_admin.close")}
              @click=${() => this.close()}
            >
              ×
            </button>
          </div>

          ${
            this.loggedIn
              ? html`
                  <label
                    class="mt-4 block text-sm font-bold"
                    for="sibau-announce"
                  >
                    ${translateText("sibau_admin.announce_label")}
                  </label>
                  <p class="text-xs text-white/60">
                    ${translateText("sibau_admin.announce_help")}
                  </p>
                  <textarea
                    id="sibau-announce"
                    class="sibau-admin-message mt-2 h-28 w-full rounded-lg border border-white/20 bg-black/30 p-2 text-white"
                    maxlength=${MAX_LENGTH}
                    .value=${this.message}
                    @input=${(e: Event) =>
                      (this.message = (e.target as HTMLTextAreaElement).value)}
                  ></textarea>
                  <div class="mt-1 text-right text-xs text-white/50">
                    ${this.message.length}/${MAX_LENGTH}
                  </div>
                  <div class="mt-2 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      class="text-sm text-white/60 underline hover:text-white"
                      @click=${() => this.logout()}
                    >
                      ${translateText("sibau_admin.log_out")}
                    </button>
                    <button
                      type="button"
                      class="sibau-admin-send rounded-lg bg-malibu-blue px-4 py-2 font-bold hover:bg-sky-500 disabled:opacity-50"
                      ?disabled=${busy || this.message.trim().length === 0}
                      @click=${() => void this.announce()}
                    >
                      📢 ${translateText("sibau_admin.send")}
                    </button>
                  </div>
                `
              : html`
                  <label
                    class="mt-4 block text-sm font-bold"
                    for="sibau-password"
                  >
                    ${translateText("sibau_admin.password")}
                  </label>
                  <form
                    class="mt-2 flex gap-2"
                    @submit=${(e: Event) => {
                      e.preventDefault();
                      void this.login();
                    }}
                  >
                    <input
                      id="sibau-password"
                      type="password"
                      autocomplete="current-password"
                      class="sibau-admin-password min-w-0 flex-1 rounded-lg border border-white/20 bg-black/30 p-2 text-white"
                      .value=${this.password}
                      @input=${(e: Event) =>
                        (this.password = (e.target as HTMLInputElement).value)}
                    />
                    <button
                      type="submit"
                      class="sibau-admin-login rounded-lg bg-malibu-blue px-4 py-2 font-bold hover:bg-sky-500 disabled:opacity-50"
                      ?disabled=${busy || this.password.length === 0}
                    >
                      ${translateText("sibau_admin.log_in")}
                    </button>
                  </form>
                `
          }
          ${this.renderStatus()}
        </div>
      </div>
    `;
  }
}
