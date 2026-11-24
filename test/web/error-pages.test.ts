import { describe, expect, it } from "vitest";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/**
 * Error pages: installed to a Home Screen heel has no back button, so a
 * browser that hits a missing page, a stale form or an ended session gets
 * a page with a way back, never a bare line of text or JSON.
 */

const PAGE = { accept: "text/html,application/xhtml+xml" };
const FORM = { ...PAGE, "content-type": "application/x-www-form-urlencoded" };

describe("error pages", () => {
  it("shows a page with a way Home for an unknown address, and text to a script", async () => {
    const h = humanPlaneHarness();
    const page = await h.fetch("/no-such-page", { headers: PAGE });
    expect(page.status).toBe(404);
    const body = await page.text();
    expect(body).toContain("<h1>Page not found</h1>");
    expect(body).toContain('href="/">Go to Home</a>');
    expect(body).toContain('<html lang="en"');

    const script = await h.fetch("/no-such-page");
    expect(script.status).toBe(404);
    expect(script.headers.get("content-type")).toContain("text/plain");
  });

  it("refuses a stale form with a page, and still refuses it", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const response = await h.fetch("/sign-out", {
      method: "POST",
      as: admin,
      headers: FORM,
      body: "csrf=wrong",
    });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("This form is out of date");
    expect(body).toContain("Go to Home");
    // Still signed in: the stale form did nothing.
    expect((await h.fetch("/activity", { as: admin })).status).toBe(200);
  });

  it("sends a form post with an ended session to sign in, and says the session ended", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const cookie = admin.cookie.replace(/=.*/, "=no-such-session");
    const post = await h.fetch("/sign-out", {
      method: "POST",
      headers: { ...FORM, cookie },
      body: `csrf=${admin.csrf}`,
    });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/sign-in?next=%2F&expired");

    const get = await h.fetch("/activity", { headers: { ...PAGE, cookie } });
    expect(get.headers.get("location")).toBe("/sign-in?next=%2Factivity&expired");
    const signIn = await (await h.fetch(get.headers.get("location") ?? "")).text();
    expect(signIn).toContain("Your session ended. Sign in again to continue.");

    // A script's request still gets a 401 it can read.
    const script = await h.fetch("/approvals/folds", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    expect(script.status).toBe(401);
  });

  it("says nothing about an ended session to a browser that never signed in", async () => {
    const h = humanPlaneHarness();
    const get = await h.fetch("/activity", { headers: PAGE });
    expect(get.headers.get("location")).toBe("/sign-in?next=%2Factivity");
  });
});
