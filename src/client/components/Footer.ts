import { assetUrl } from "@openfront/shared/AssetUrls";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  composeVersionDisplay,
  desktopVersion,
  isDesktopShell,
} from "../DesktopShell";
import { currentGameVersion } from "../GameVersion";

@customElement("page-footer")
export class Footer extends LitElement {
  // Per instance, not at module scope: currentGameVersion reads
  // BOOTSTRAP_CONFIG, which the server injects into the page and which is not
  // guaranteed to exist at the moment this module is first imported.
  private readonly gameVersion = currentGameVersion();

  // Starts as the game version alone and gains the shell version once the
  // bridge answers, so the line is never blank while that call is in flight.
  @state() private versionLabel = this.gameVersion;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // desktopVersion() resolves null off the desktop shell and on its own
    // timeout, so this can only ever leave the label as-is or extend it.
    void desktopVersion().then((shellVersion) => {
      this.versionLabel = composeVersionDisplay(this.gameVersion, shellVersion);
    });
  }

  render() {
    // Scaled to 3/4 on compact screens (styles.css), like the nav bar, from sm
    // up so phones keep their full-size footer.
    return html`
      <footer
        class="[.in-game_&]:hidden bg-zinc-900/90 backdrop-blur-md flex flex-col items-center justify-center gap-1 pt-1 pb-3 text-white/50 w-full border-t border-white/10 shrink-0 relative z-50 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-0 sm:compact:[zoom:0.75]"
      >
        <!-- Icons and legal links stay centred on the bar; on desktop they
             share it with the Steam promo, which gets its own grid column so
             the two can never overlap however wide a translation runs. -->
        <div
          class="flex w-full flex-col items-center gap-1 lg:col-start-2 lg:w-auto"
        >
          <div
            class="flex items-center justify-center gap-4 lg:gap-6 pt-2 w-full relative"
          >
            <!-- Sibau Wars: AGPL-3.0 section 13 -- players over the network
                 must be offered the source. Keep this link pointing at the
                 public repo you deploy from. -->
            <a
              href="https://github.com/aughos12-pixel/sibau-wars"
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center gap-2 opacity-60 hover:opacity-100 transition-all text-sm"
            >
              <img
                src=${assetUrl("icons/github-mark-white.svg")}
                alt=""
                class="h-6 w-6 object-contain pointer-events-none"
                draggable="false"
              />
              Source code
            </a>
          </div>
          <!-- Steam build only. The nav bar shows the game version alone so it
               reads the same across web and Steam; the full string, shell
               version included, lives down here where a player can quote it
               in a bug report. -->
          ${
            isDesktopShell()
              ? html`<div
                  class="footer-version text-xs mt-1 lg:mt-2 text-center px-4"
                >
                  ${this.versionLabel}
                </div>`
              : nothing
          }
          <div
            class="text-xs mt-1 lg:mt-2 flex items-center justify-center gap-4 px-4"
          >
            <a
              href="/terms-of-service.html"
              data-i18n="main.terms_of_service"
              target="_blank"
              class="hover:text-white transition-colors"
            ></a>
            <span data-i18n="main.copyright"></span>
            <a
              href="/privacy-policy.html"
              data-i18n="main.privacy_policy"
              target="_blank"
              class="hover:text-white transition-colors"
            ></a>
          </div>
        </div>

        <!-- Sibau Wars: no Steam store button (the game isn't on Steam). -->

        <!-- Single instance: translateText() resolves the active language via
             document.querySelector("lang-selector"), so a second one would
             shadow it. -->
        <lang-selector
          class="absolute right-4 top-3 lg:top-1/2 lg:-translate-y-1/2"
        ></lang-selector>
      </footer>
    `;
  }
}
