import { describe, expect, it } from "vitest";
import { bootstrapPageHtml } from "../../src/management/bootstrap-page.js";
import { MANAGEMENT_CSP } from "../../src/management/security-headers.js";

describe("management UI page", () => {
  it("exchanges the fragment token, resumes without browser storage, and lists admin plus diagnostic views", () => {
    const html = bootstrapPageHtml();
    expect(html).toContain("history.replaceState");
    expect(html).toContain("/auth/exchange");
    expect(html).toContain("/auth/resume");
    expect(html).toContain('referrerPolicy: "no-referrer"');
    expect(html).toContain('params.get("t")');
    expect(html).toContain("Providers");
    expect(html).toContain("Accounts");
    expect(html).toContain("Pools");
    expect(html).toContain("Profiles");
    expect(html).toContain("Health / quota");
    expect(html).toContain("Audit");
    expect(html).toContain("Route traces");
    expect(html).toContain("Direct env account");
    expect(html).toContain("Credential env name");
    expect(html).toContain("Stores the variable name only");
    expect(html).toContain('for="view-select"');
    expect(html).toContain("Skip to main content");
    expect(html).toContain("aria-live");
    expect(html).toContain('role="status"');
    expect(html).toContain('id="main" tabindex="-1"');
    expect(html).toContain("Logout");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");
    expect(html).not.toMatch(/<input[^>]+type=["']file["']/);
    expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/);
    expect(html).toContain(MANAGEMENT_CSP);
    expect(html).toContain("viewport");
    expect(html).toContain("--target:44px");
    expect(html).toContain("#main:focus-visible");
    expect(html).toContain("min-height:var(--target)");
    expect(html).toContain("@media (min-width:1024px)");
  });

  it("shows provider/model identity columns on profiles and traces tables", () => {
    const html = bootstrapPageHtml();
    expect(html).toContain('["Name","Harness","Provider","Pool","Primary","Fast","Reasoning","Version",""]');
    expect(html).toContain('["When","Request","Profile","Reason","Requested","Resolved","Provider","Adapter","Selected","Candidates"]');
    expect(html).toContain("item.intent.sourceSelector");
    expect(html).toContain("item.effectiveModelDecision.target");
    expect(html).toContain("target.physicalModelId");
    expect(html).toContain("target.accessProviderId");
    expect(html).toContain("target.adapterId");
    expect(html).not.toContain('["Name","Harness","Pool","Version",""]');
    expect(html).not.toContain('["When","Request","Profile","Strategy","Reason","Selected","Candidates"]');
  });
});
