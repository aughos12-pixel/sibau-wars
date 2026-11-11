import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ANNOUNCEMENT_LIFETIME_MS,
  SIBAU_ADMIN_HEADER,
  SibauAdmin,
} from "../../src/server/SibauAdmin";

describe("Sibau Wars admin announcements", () => {
  let server: http.Server;
  let base: string;
  let password: string | undefined;
  let now: number;

  beforeEach(async () => {
    password = "correct horse battery";
    now = 1_000_000;
    const app = express();
    app.use(express.json());
    new SibauAdmin(
      () => password,
      () => now,
    ).register(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown, pw?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(pw === undefined ? {} : { [SIBAU_ADMIN_HEADER]: pw }),
      },
      body: JSON.stringify(body),
    });
  const latest = async () =>
    (
      (await (await fetch(`${base}/api/sibau/announcement`)).json()) as {
        announcement: { id: number; message: string } | null;
      }
    ).announcement;

  test("the right password can announce, and everyone can read it", async () => {
    expect(await latest()).toBeNull();
    expect((await post("/api/sibau/admin/login", {}, password)).status).toBe(
      200,
    );
    const res = await post(
      "/api/sibau/admin/announce",
      { message: "  Server restart in 5 minutes!  " },
      password,
    );
    expect(res.status).toBe(200);
    expect((await latest())?.message).toBe("Server restart in 5 minutes!");
  });

  test("a wrong or missing password can't", async () => {
    expect((await post("/api/sibau/admin/login", {}, "nope")).status).toBe(401);
    expect(
      (await post("/api/sibau/admin/announce", { message: "hi" }, "nope"))
        .status,
    ).toBe(401);
    expect(
      (await post("/api/sibau/admin/announce", { message: "hi" })).status,
    ).toBe(401);
    expect(await latest()).toBeNull();
  });

  test("admin is switched off (404) without a password set", async () => {
    password = undefined;
    expect((await post("/api/sibau/admin/login", {}, "")).status).toBe(404);
    expect(
      (await post("/api/sibau/admin/announce", { message: "hi" }, "x")).status,
    ).toBe(404);
  });

  test("locks out after 10 wrong passwords", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post("/api/sibau/admin/login", {}, `bad${i}`)).status).toBe(
        401,
      );
    }
    // Even the right one waits out the cool-down...
    expect((await post("/api/sibau/admin/login", {}, password)).status).toBe(
      429,
    );
    // ...which ends after 10 minutes.
    now += 10 * 60_000 + 1;
    expect((await post("/api/sibau/admin/login", {}, password)).status).toBe(
      200,
    );
  });

  test("rejects empty and too-long messages", async () => {
    for (const message of ["", "   ", "x".repeat(301)]) {
      expect(
        (await post("/api/sibau/admin/announce", { message }, password)).status,
      ).toBe(400);
    }
  });

  test("an announcement fades after a minute; a new one gets a new id", async () => {
    await post("/api/sibau/admin/announce", { message: "one" }, password);
    const first = await latest();
    await post("/api/sibau/admin/announce", { message: "two" }, password);
    const second = await latest();
    expect(second?.id).toBeGreaterThan(first!.id);
    now += ANNOUNCEMENT_LIFETIME_MS + 1;
    expect(await latest()).toBeNull();
  });
});
