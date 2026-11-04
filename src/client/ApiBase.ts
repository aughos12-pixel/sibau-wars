import { ClientEnv } from "./ClientEnv";

// The account/shop API origin (api.<audience>). Lives apart from Api.ts so
// modules that Api.ts itself depends on (ServerList) can reach it without an
// import cycle; Api.ts re-exports both for its existing importers.

export function getApiBase() {
  // Sibau Wars is self-hosted (the build default, see vite.config.ts): there
  // is no account/shop API, so the client talks to the game server's own
  // /sibau-api stub (Master.ts), which answers 404 for everything.
  if (process.env.SELF_HOSTED === "true" && !process.env.API_DOMAIN) {
    return `${window.location.protocol}//${window.location.host}/sibau-api`;
  }

  const domainname = getAudience();

  if (domainname === "localhost") {
    const apiDomain = process.env.API_DOMAIN;
    if (apiDomain) {
      return `https://${apiDomain}`;
    }
    return localStorage.getItem("apiHost") ?? "http://localhost:8787";
  }

  return `https://api.${domainname}`;
}

export function getAudience() {
  // Sourced from BOOTSTRAP_CONFIG (server/desktop-injected) rather than
  // window.location, so the desktop app (app://openfront) targets real infra.
  return ClientEnv.jwtAudience();
}
