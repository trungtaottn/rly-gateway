import { expect, test } from "@playwright/test";
import { startManagementBrowser } from "./management-harness.js";

test.describe("management UI AT-031", () => {
  test("keyboard path and 375/1024 layouts stay secret-free", async ({ page }) => {
    const session = await startManagementBrowser();
    try {
      await page.goto(`${session.origin}/#t=${session.token}`);
      await expect(page.getByRole("heading", { name: "RLY Gateway" })).toBeVisible();
      await expect(page).toHaveURL(`${session.origin}/?view=providers`);

      await page.setViewportSize({ width: 375, height: 812 });
      await expect(page.locator(".mobile-nav")).toBeVisible();
      await expect(page.locator("nav.nav")).toBeHidden();

      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main")).toBeFocused();

      await page.getByLabel("View").selectOption("health");
      await expect(page.getByRole("heading", { name: "Health / quota" })).toBeVisible();
      await expect(page.locator("#status")).not.toHaveText("");

      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(page.locator("nav.nav")).toBeVisible();
      await expect(page.locator(".mobile-nav")).toBeHidden();

      await page.getByRole("navigation", { name: "Management" }).getByRole("button", { name: "Providers" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();

      await page.getByLabel("Name (catalog id)").focus();
      await page.keyboard.type("openrouter");
      await page.getByRole("button", { name: "Save" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("cell", { name: "openrouter" })).toBeVisible();
      await expect(page.locator("#status")).not.toHaveText("");

      await page.getByRole("navigation", { name: "Management" }).getByRole("button", { name: "Audit" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
      await expect(page.locator("#panel table")).toBeVisible();

      await page.getByRole("button", { name: "Logout" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#gate-message")).toHaveText(/(Logged out\.|Session missing)/, { timeout: 10000 });
      await expect(page.locator("#status")).toHaveAttribute("role", "alert");

      expect(Number(await page.evaluate("Object.keys(localStorage).length"))).toBe(0);
      expect(Number(await page.evaluate("Object.keys(sessionStorage).length"))).toBe(0);
      expect(await page.locator('input[type="file"]').count()).toBe(0);
      const html = await page.content();
      expect(html).not.toMatch(/mgmt-fixture|accessToken|refreshToken/i);
      expect(html).not.toContain(session.token);
    } finally {
      await session.stop();
    }
  });
});
