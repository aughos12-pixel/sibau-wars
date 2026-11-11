import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";

/**
 * Sibau Wars: admin commands for the server owner.
 *
 * Protected by one secret password from the SIBAU_ADMIN_PASSWORD environment
 * variable (set it in Render → Environment). Unset = admin is switched off
 * and the admin routes answer 404.
 *
 * Announcements live in this (master) process. Every open page — homepage
 * and every game — asks GET /api/sibau/announcement every few seconds and
 * shows a new one once, so one announce reaches everyone on the server.
 */

export const SIBAU_ADMIN_HEADER = "x-sibau-admin";
export const MAX_ANNOUNCEMENT_LENGTH = 300;
/** How long after sending a page that opens still shows the announcement. */
export const ANNOUNCEMENT_LIFETIME_MS = 60_000;
/** Wrong passwords allowed per address before a cool-down. */
const MAX_FAILED_LOGINS = 10;
/** ...and across all addresses (addresses come from proxy headers). */
const MAX_FAILED_LOGINS_TOTAL = 100;
const FAILED_LOGIN_WINDOW_MS = 10 * 60_000;

export interface Announcement {
  id: number;
  message: string;
  sentAt: number;
}

const AnnounceBodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_ANNOUNCEMENT_LENGTH),
});

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time whatever the lengths.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class SibauAdmin {
  private latest: Announcement | null = null;
  private nextId = 1;
  private failures = new Map<string, number[]>();
  private allFailures: number[] = [];

  constructor(
    private password: () => string | undefined,
    private now: () => number = Date.now,
  ) {}

  /** The announcement pages should show, if one is still fresh. */
  current(): Announcement | null {
    const a = this.latest;
    if (a === null || this.now() - a.sentAt > ANNOUNCEMENT_LIFETIME_MS) {
      return null;
    }
    return a;
  }

  announce(message: string): Announcement {
    this.latest = { id: this.nextId++, message, sentAt: this.now() };
    return this.latest;
  }

  /** "off" when no password is set, "locked" after too many wrong tries. */
  check(provided: unknown, who: string): "ok" | "off" | "wrong" | "locked" {
    const expected = this.password();
    if (expected === undefined || expected.length === 0) return "off";
    const now = this.now();
    const fresh = (t: number) => now - t < FAILED_LOGIN_WINDOW_MS;
    const recent = (this.failures.get(who) ?? []).filter(fresh);
    this.allFailures = this.allFailures.filter(fresh);
    if (
      recent.length >= MAX_FAILED_LOGINS ||
      this.allFailures.length >= MAX_FAILED_LOGINS_TOTAL
    ) {
      this.failures.set(who, recent);
      return "locked";
    }
    if (typeof provided === "string" && sameSecret(provided, expected)) {
      this.failures.delete(who);
      return "ok";
    }
    recent.push(now);
    this.failures.set(who, recent);
    this.allFailures.push(now);
    // Forget addresses that stopped trying, so the map can't grow forever.
    if (this.failures.size > 10_000) this.failures.clear();
    return "wrong";
  }

  /** Answers the request itself and returns false unless the password is right. */
  private authorize(req: Request, res: Response): boolean {
    const who = req.ip ?? "unknown";
    const result = this.check(req.headers[SIBAU_ADMIN_HEADER], who);
    if (result === "ok") return true;
    if (result === "off") res.status(404).end();
    else if (result === "locked") res.status(429).json({ error: "locked" });
    else res.status(401).json({ error: "wrong_password" });
    return false;
  }

  register(app: Express) {
    app.get("/api/sibau/announcement", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ announcement: this.current() });
    });

    app.post("/api/sibau/admin/login", (req, res) => {
      if (!this.authorize(req, res)) return;
      res.json({ ok: true });
    });

    app.post("/api/sibau/admin/announce", (req, res) => {
      if (!this.authorize(req, res)) return;
      const parsed = AnnounceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "bad_message" });
        return;
      }
      res.json({ announcement: this.announce(parsed.data.message) });
    });
  }
}
