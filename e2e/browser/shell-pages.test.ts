import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { createHumanApp } from "../../src/web/app.ts";
import { createEnrollment, Passkeys, relyingPartyFor } from "../../src/web/passkeys.ts";
import { createPreviewApp } from "../../src/web/ui/preview/app.ts";
import { approvalHarness } from "../../test/helpers/approvals.ts";
import { TEST_VAPID_PUBLIC_KEY } from "../../test/helpers/human-plane.ts";
import { captureLogger } from "../../test/helpers/log.ts";

/**
 * Activity, sign-in, enrollment, welcome and error pages in a real browser:
 * nothing wider than a phone, the passkey status above the tab bar, the
 * Activity panels closing like menus, and sign-in working again after a
 * wrong passkey without a reload.
 */

async function listen(fetch: (request: Request) => Response | Promise<Response>) {
  const server = createServer(getRequestListener(fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

const close = (server: Server) => () =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const SHELL_STORIES = [
  "activity/busy",
  "activity/empty",
  "activity/filtered-empty",
  "activity/long",
  "activity/older",
  "sign-in-passkey/pending",
  "sign-in-passkey/denied",
  "sign-in-passkey/not-enrolled",
  "sign-in-oidc/denied",
  "enroll/open",
  "enroll/waiting",
  "enroll/invalid",
  "welcome/new",
  "error/not-found",
  "error/stale-form",
];

describe("shell pages in a browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function phone(width: number, theme: "light" | "dark" = "light"): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      hasTouch: true,
      isMobile: true,
      colorScheme: theme,
    });
    onTestFinished(() => context.close());
    return context.newPage();
  }

  it("fits every shell page on a 360 and a 390 px phone, light and dark", async () => {
    const { server, port } = await listen(createPreviewApp().fetch);
    onTestFinished(close(server));
    const wide: string[] = [];
    for (const width of [360, 390]) {
      for (const theme of ["light", "dark"] as const) {
        const page = await phone(width, theme);
        for (const story of SHELL_STORIES) {
          await page.goto(`http://127.0.0.1:${port}/${story}?theme=${theme}`);
          const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
          if (scroll > width) wide.push(`${story} ${theme} at ${width}: ${scroll}px`);
        }
      }
    }
    expect(wide).toEqual([]);
  });

  it("lays Activity rows out with their own padding, badge at the top", async () => {
    const { server, port } = await listen(createPreviewApp().fetch);
    onTestFinished(close(server));
    const page = await phone(390);
    await page.goto(`http://127.0.0.1:${port}/activity/busy?theme=light`);
    const cells = await page.evaluate(() => {
      const row = document.querySelector("#activity tr[data-id]");
      const kind = row?.querySelector(".act-kind");
      const what = row?.querySelector(".act-what");
      return {
        padding: kind ? getComputedStyle(kind).padding : "",
        gap:
          kind && what
            ? what.getBoundingClientRect().top - kind.getBoundingClientRect().bottom
            : -1,
      };
    });
    expect(cells.padding).toBe("0px");
    expect(cells.gap).toBeLessThan(8);
  });

  it("closes the Filter panel on Escape or a click outside, and keeps it open for a click inside", async () => {
    const { server, port } = await listen(createPreviewApp().fetch);
    onTestFinished(close(server));
    const page = await phone(360);
    await page.goto(`http://127.0.0.1:${port}/activity/busy?theme=light`);
    const open = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("details.act-filter, details.audit-export")]
          .filter((d) => (d as HTMLDetailsElement).open)
          .map((d) => d.className),
      );
    await page.locator(".act-filter > summary").click();
    await page.locator(".act-option").nth(1).click();
    expect(await open()).toEqual(["act-filter"]);
    await page.keyboard.press("Escape");
    expect(await open()).toEqual([]);
    expect(await page.evaluate(() => document.activeElement?.closest("details")?.className)).toBe(
      "act-filter",
    );
    await page.locator(".audit-export > summary").click();
    await page.mouse.click(5, 5);
    expect(await open()).toEqual([]);
  });

  it("keeps a dialog inside a landscape phone and the page still behind it", async () => {
    const { server, port } = await listen(createPreviewApp().fetch);
    onTestFinished(close(server));
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      hasTouch: true,
      isMobile: true,
    });
    onTestFinished(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/agents/busy?theme=light`);
    await page.locator("button[aria-controls=add-agent-dialog]").click();
    const open = await page.evaluate(() => {
      const box = document.querySelector("dialog[open]")?.getBoundingClientRect();
      return {
        bottom: box?.bottom ?? Infinity,
        overflow: getComputedStyle(document.documentElement).overflow,
      };
    });
    expect(open.bottom).toBeLessThanOrEqual(390);
    expect(open.overflow).toBe("hidden");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
      "visible",
    );
  });

  it("shows the passkey status above the phone tab bar", async () => {
    const { server, port } = await listen(createPreviewApp().fetch);
    onTestFinished(close(server));
    const page = await phone(390);
    await page.goto(`http://127.0.0.1:${port}/activity/busy?theme=light`);
    const box = await page.evaluate(() => {
      const status = document.getElementById("heel-ceremony-status");
      if (status) status.textContent = "Waiting for your passkey…";
      const nav = document.querySelector(".site nav");
      return {
        status: status?.getBoundingClientRect().bottom ?? 0,
        nav: nav?.getBoundingClientRect().top ?? 0,
      };
    });
    expect(box.status).toBeLessThanOrEqual(box.nav);
  });

  it("signs in after a wrong passkey without a reload, and says when a browser has no passkeys", async () => {
    const h = approvalHarness({});
    h.clock.advance(Date.now() - h.clock.now.getTime());
    const home = mkdtempSync(join(tmpdir(), "heel-e2e-shell-"));
    mkdirSync(rulesPaths(home).ownersDir);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(close(server));
    const { port } = server.address() as AddressInfo;
    const publicUrl = new URL(`http://localhost:${port}`);
    const app = createHumanApp({
      db: h.t.db,
      orgId: h.t.orgId,
      log: captureLogger().logger,
      publicUrl,
      passkeys: new Passkeys(h.t.db, relyingPartyFor(publicUrl)),
      approvals: h.store,
      pauses: h.pauseStore,
      rules: h.rules,
      vapidPublicKey: TEST_VAPID_PUBLIC_KEY,
      agentPublicUrl: null,
      upstreamOAuth: null,
      watchFallback: false,
      ruleFiles: { paths: rulesPaths(home), reload: () => {} },
      providerClients: { google: null, microsoft: null },
      now: () => h.clock.now,
    });
    server.on("request", getRequestListener(app.fetch));

    const context = await browser.newContext();
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const link = createEnrollment(h.t.db, {
      orgId: h.t.orgId,
      userName: "owner",
      publicUrl,
      now: h.clock.now,
    });
    await page.goto(link.url);
    await page.getByRole("button", { name: "Create a passkey" }).click();
    await page.waitForURL(/\/welcome$/);
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL(/\/sign-in/);

    // The first answer is spoiled on its way to heel, as a wrong passkey would be.
    let spoiled = false;
    await page.route("**/sign-in", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || spoiled) return route.continue();
      spoiled = true;
      const body = JSON.parse(request.postData() ?? "{}");
      body.response.response.signature = "AAAA";
      await route.continue({ postData: JSON.stringify(body) });
    });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByText("That passkey didn't sign you in.").waitFor();
    // The same button works again on the same page.
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

    // A browser without WebAuthn hears so in words, not a script error.
    const bare = await browser.newPage();
    onTestFinished(() => bare.close());
    await bare.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", { value: undefined });
    });
    await bare.goto(`${publicUrl.origin}/sign-in`);
    await bare.getByRole("button", { name: "Sign in with a passkey" }).click();
    await bare.getByText("This browser can't use passkeys.").waitFor();
  });
});
