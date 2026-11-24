import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPreviewApp } from "../../src/web/ui/preview/app.ts";
import { ALL_STORIES } from "../../src/web/ui/preview/stories.ts";

/**
 * The settings pages (Rules, Agents, Pause, Devices, People, Modes, Grants,
 * Standing approvals) in a real browser at phone widths, over the preview
 * harness's fixture stories: no page scrolls sideways, and menus, popovers
 * and dialogs open where they can be seen and used.
 */

const SETTINGS = new Set([
  "rules",
  "rule-history",
  "agents",
  "pause-control",
  "devices",
  "people",
  "modes",
  "grants",
  "standing-approvals",
]);
const STORIES = ALL_STORIES.filter((s) => SETTINGS.has(s.component)).map(
  (s) => `/${s.component}/${s.state}`,
);
const PHONES = [360, 390] as const;
const WIDTHS = [...PHONES, 768] as const;

let server: Server;
let origin: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(getRequestListener(createPreviewApp().fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function open(path: string, width: number, theme = "light"): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 760 },
    // Not isMobile: a mobile viewport widens to fit the page, which hides sideways scroll.
    hasTouch: width < 1000,
  });
  const page = await context.newPage();
  await page.goto(`${origin}${path}?theme=${theme}`);
  return page;
}

/** How far the page scrolls sideways: 0 when it fits. */
function sideways(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Where `el` is cut off: by the viewport's sides, or by an ancestor that clips its overflow. */
function clipped(el: Locator): Promise<string[]> {
  return el.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const out: string[] = [];
    if (box.left < -1 || box.right > window.innerWidth + 1) out.push("off the side of the screen");
    for (let p = node.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const outer = p.getBoundingClientRect();
      if (
        box.bottom > outer.bottom + 1 ||
        box.top < outer.top - 1 ||
        box.right > outer.right + 1 ||
        box.left < outer.left - 1
      )
        out.push(`clipped by ${p.tagName.toLowerCase()}.${p.className}`);
    }
    return out;
  });
}

describe("settings pages at phone and tablet widths", () => {
  for (const width of WIDTHS) {
    it.each(STORIES)(`%s fits a ${String(width)}px screen`, async (path) => {
      const page = await open(path, width);
      try {
        expect(await sideways(page)).toBe(0);
      } finally {
        await page.context().close();
      }
    });
  }
});

describe("Rules", () => {
  it("shows every choice in the last rule's decision menu", async () => {
    for (const width of [390, 1280]) {
      const page = await open("/rules/loaded", width);
      try {
        const triggers = page.locator(".rule-list .ui-select-trigger");
        await triggers.last().click();
        const list = page.locator(".ui-select-content:not([hidden])");
        expect(await clipped(list)).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  });
});

describe("People", () => {
  it("fits long names and emails in each person's row, with no sideways scroll", async () => {
    for (const width of PHONES) {
      const page = await open("/people/long-names", width);
      try {
        const extra = await page
          .locator(".table-scroll")
          .evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(extra, `at ${String(width)}`).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  });

  it("opens each person's menu on screen", async () => {
    for (const width of PHONES) {
      const page = await open("/people/admin", width);
      try {
        const menus = page.locator(".set-menu > summary");
        for (let i = 0; i < (await menus.count()); i++) {
          await menus.nth(i).click();
          const panel = page.locator(".set-menu[open] .set-menu-panel");
          expect(await clipped(panel), `menu ${String(i)} at ${String(width)}`).toEqual([]);
          await menus.nth(i).click();
        }
      } finally {
        await page.context().close();
      }
    }
  });
});

describe("Modes", () => {
  it("shows each person's mode and what applies without a sideways scroll on a phone", async () => {
    for (const path of ["/modes/mixed", "/modes/watch-fallback"]) {
      for (const width of PHONES) {
        const page = await open(path, width);
        try {
          const extra = await page
            .locator(".table-scroll")
            .evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(extra, `${path} at ${String(width)}`).toBe(0);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});

/** The contrast ratio of `el`'s text against the first opaque background behind it, after opacity. */
function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx === null) throw new Error("no canvas");
    const rgba = (value: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    let bg = [255, 255, 255];
    for (let p: Element | null = node; p; p = p.parentElement) {
      const c = rgba(getComputedStyle(p).backgroundColor);
      if ((c[3] ?? 0) === 255) {
        bg = c.slice(0, 3);
        break;
      }
    }
    let alpha = 1;
    for (let p: Element | null = node; p; p = p.parentElement) {
      alpha *= Number(getComputedStyle(p).opacity);
    }
    const fg = rgba(getComputedStyle(node).color);
    alpha *= (fg[3] ?? 255) / 255;
    const mixed = bg.map((b, i) => (fg[i] ?? 0) * alpha + b * (1 - alpha));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const [hi, lo] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  });
}

describe("Agents", () => {
  it("fits an agent's manage menu on a phone, even for a 64-character name", async () => {
    for (const path of ["/agents/busy", "/agents/long-names"]) {
      for (const width of PHONES) {
        const page = await open(path, width);
        try {
          await page.locator(".row-manage > summary").first().click();
          const panel = page.locator(".row-manage[open] .row-manage-panel");
          expect(await clipped(panel), `${path} at ${String(width)}`).toEqual([]);
          expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
          expect(await sideways(page)).toBe(0);
        } finally {
          await page.context().close();
        }
      }
    }
  });

  it("keeps a revoked agent's details readable in both themes", async () => {
    for (const theme of ["light", "dark"]) {
      const page = await open("/agents/busy", 1280, theme);
      try {
        const subs = page.locator("tr[data-revoked] .cell-sub, tr[data-revoked] .muted");
        expect(await subs.count()).toBeGreaterThan(0);
        for (let i = 0; i < (await subs.count()); i++) {
          expect(await contrast(subs.nth(i)), `${theme} ${String(i)}`).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        await page.context().close();
      }
    }
  });
});

describe("dates", () => {
  it("never breaks a date across two lines", async () => {
    for (const path of ["/pause-control/long-names", "/standing-approvals/long-names"]) {
      for (const width of PHONES) {
        const page = await open(path, width);
        try {
          const broken = await page.evaluate(() =>
            [...document.querySelectorAll("main time")]
              .filter((t) => t.getClientRects().length > 1)
              .map((t) => t.textContent),
          );
          expect(broken, `${path} at ${String(width)}`).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});

describe("tap targets on a touch screen", () => {
  const SMALL: readonly [string, string][] = [
    ["/pause-control/paused", ".ui-switch[role=switch]"],
    ["/pause-control/pending", ".pause-everything .btn"],
    ["/modes/mixed", "button.seg-item"],
    ["/modes/mixed", ".set-fold > summary"],
    ["/people/admin", ".set-menu > summary"],
    ["/agents/busy", ".row-manage > summary"],
    ["/grants/busy", ".how-fold > summary"],
    ["/grants/busy", ".cell-actions .btn"],
    ["/rules/loaded", ".rule-remove"],
    ["/rule-history/busy", ".fold > summary"],
    ["/devices/several", ".settings-row-foot .btn"],
  ];

  it.each(SMALL)("%s: %s takes a tap 22px from its centre", async (path, selector) => {
    const page = await open(path, 390);
    try {
      const control = page.locator(selector).first();
      await control.scrollIntoViewIfNeeded();
      const misses = await control.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [
          [x, y - 21],
          [x, y + 21],
          [box.left + Math.min(box.width, 44) / 2 - 21, y],
        ]
          .filter(([px, py]) => {
            const hit = document.elementFromPoint(px ?? 0, py ?? 0);
            return !(hit !== null && (hit === el || el.contains(hit)));
          })
          .map(([px, py]) => `${String(Math.round(px ?? 0))},${String(Math.round(py ?? 0))}`);
      });
      expect(misses).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});

describe("menus inside a dialog", () => {
  it("opens a dialog's last menu where the dialog doesn't cut it off", async () => {
    for (const [path, dialog] of [
      ["/grants/busy", "grant-dialog"],
      ["/agents/busy", "add-agent-dialog"],
    ] as const) {
      for (const width of [390, 1280]) {
        const page = await open(path, width);
        try {
          await page.locator(`button[aria-controls="${dialog}"]`).click();
          await page.locator(`#${dialog} .ui-select-trigger`).last().click();
          const list = page.locator(".ui-select-content:not([hidden])");
          expect(await clipped(list), `${path} at ${String(width)}`).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});
