import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SibauAdminPanel,
  SibauAnnouncement,
} from "../../src/client/SibauAnnouncements";

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init?: RequestInit) =>
    handler(url, init),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

describe("announcement banner (Sibau Wars)", () => {
  test("shows a new announcement once", async () => {
    mockFetch(() => Response.json({ announcement: null }));
    const banner = new SibauAnnouncement();
    document.body.appendChild(banner);
    const a = { id: 1, message: "Hello <b>everyone</b>", sentAt: 5 };
    banner.showIfNew(a);
    await banner.updateComplete;
    const box = banner.querySelector(".sibau-announcement");
    // The admin's text is shown as text, never as HTML.
    expect(box?.textContent).toContain("Hello <b>everyone</b>");
    expect(box?.querySelector("b")).toBeNull();
    (banner.querySelector("button") as HTMLButtonElement).click();
    await banner.updateComplete;
    expect(banner.querySelector(".sibau-announcement")).toBeNull();
    banner.showIfNew(a);
    await banner.updateComplete;
    expect(banner.querySelector(".sibau-announcement")).toBeNull();
  });

  test("picks up an announcement from the server", async () => {
    mockFetch(() =>
      Response.json({
        announcement: { id: 3, message: "From server", sentAt: 9 },
      }),
    );
    const banner = new SibauAnnouncement();
    document.body.appendChild(banner);
    await vi.waitFor(() =>
      expect(
        banner.querySelector(".sibau-announcement")?.textContent,
      ).toContain("From server"),
    );
  });
});

describe("admin panel (Sibau Wars)", () => {
  test("is hidden unless the address ends with #admin", async () => {
    const panel = new SibauAdminPanel();
    document.body.appendChild(panel);
    await panel.updateComplete;
    expect(panel.querySelector(".sibau-admin-panel")).toBeNull();
  });

  test("logs in with the password, remembers it, and announces", async () => {
    const calls: { url: string; pw: string | null; body: string }[] = [];
    mockFetch((url, init) => {
      const pw = new Headers(init?.headers).get("x-sibau-admin");
      calls.push({ url, pw, body: String(init?.body ?? "") });
      if (pw !== "secret") return new Response(null, { status: 401 });
      return Response.json({ ok: true });
    });
    window.location.hash = "#admin";
    const panel = new SibauAdminPanel();
    document.body.appendChild(panel);
    await panel.updateComplete;

    const input = panel.querySelector<HTMLInputElement>(
      ".sibau-admin-password",
    )!;
    input.value = "wrong";
    input.dispatchEvent(new Event("input"));
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".sibau-admin-login")!.click();
    await vi.waitFor(() =>
      expect(panel.querySelector(".sibau-admin-status")?.textContent).toContain(
        "sibau_admin.wrong_password",
      ),
    );

    input.value = "secret";
    input.dispatchEvent(new Event("input"));
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".sibau-admin-login")!.click();
    await vi.waitFor(() =>
      expect(panel.querySelector(".sibau-admin-message")).not.toBeNull(),
    );
    expect(localStorage.getItem("sibau.adminPassword")).toBe("secret");

    const box = panel.querySelector<HTMLTextAreaElement>(
      ".sibau-admin-message",
    )!;
    box.value = "Tournament at 18:00!";
    box.dispatchEvent(new Event("input"));
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".sibau-admin-send")!.click();
    await vi.waitFor(() =>
      expect(panel.querySelector(".sibau-admin-status")?.textContent).toContain(
        "sibau_admin.sent",
      ),
    );
    const sent = calls.find((c) => c.url.endsWith("/announce"));
    expect(sent?.pw).toBe("secret");
    expect(JSON.parse(sent!.body)).toEqual({ message: "Tournament at 18:00!" });
  });
});
