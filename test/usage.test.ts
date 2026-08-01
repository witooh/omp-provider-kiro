import { afterEach, describe, expect, it } from "bun:test";
import { resetKiroProfileArnCache } from "../src/management.js";
import { fetchKiroUsage, formatKiroUsage } from "../src/usage.js";
import { vi } from "./vi.js";

const auth = { accessToken: "test-access-token", region: "us-east-1" };
const profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test";
// 2026-08-30T00:00:00Z, matching the epoch-seconds shape the control plane returns.
const nextDateReset = 1788220800;
const now = Date.UTC(2026, 7, 1);

afterEach(() => {
  resetKiroProfileArnCache();
  vi.unstubAllGlobals();
});

describe("Kiro usage", () => {
  it("requests credit limits for the given profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ nextDateReset }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKiroUsage(auth, profileArn)).resolves.toEqual({ nextDateReset });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [rawUrl, request] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://management.us-east-1.kiro.dev/Get-Usage-Limits");
    expect(request.method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: "KIRO_CLI",
      resourceType: "CREDIT",
      isEmailRequired: "false",
      profileArn,
    });
  });

  it("resolves a profile first when the credential carries none", async () => {
    // Without a profileArn the control plane answers 400 "Invalid profileArn", never a usable body.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ profiles: [{ arn: profileArn }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ nextDateReset }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKiroUsage(auth)).resolves.toEqual({ nextDateReset });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://management.us-east-1.kiro.dev/List-Available-Profiles");
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("profileArn")).toBe(profileArn);
  });

  it("surfaces a control-plane failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchKiroUsage(auth, profileArn)).rejects.toThrow(
      "Kiro management GetUsageLimits failed in us-east-1: 500 Server Error",
    );
  });

  it("renders each bucket with its utilization and reset window", () => {
    const rendered = formatKiroUsage(
      {
        nextDateReset,
        subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            displayName: "Credit",
            displayNamePlural: "Credits",
            currentUsage: 75,
            currentUsageWithPrecision: 75.52,
            usageLimit: 1000,
            usageLimitWithPrecision: 1000,
            currentOverages: 0,
            overageCharges: 0,
          },
          {
            resourceType: "SPEC",
            displayName: "Spec request",
            currentUsage: 0,
            usageLimit: 0,
            currentOverages: 0,
            overageCharges: 0,
          },
        ],
      },
      now,
    );

    expect(rendered).toContain("Kiro — KIRO PRO");
    expect(rendered).toContain("7.6% used · 75.52 / 1000");
    // A zero limit must not divide into NaN%.
    expect(rendered).toContain("0.0% used · 0 / 0");
    expect(rendered).toContain("resets in 31d · https://app.kiro.dev/account/usage");
    const bar = rendered.split("\n")[1]?.match(/[█░]+/)?.[0];
    expect(bar).toHaveLength(28);
    expect(bar?.startsWith("██░")).toBe(true);
  });

  it("reports overage charges when the account is past its limit", () => {
    const rendered = formatKiroUsage({
      usageBreakdown: {
        resourceType: "CREDIT",
        currentUsage: 1020,
        currentUsageWithPrecision: 1020.5,
        usageLimit: 1000,
        currentOverages: 20,
        currentOveragesWithPrecision: 20.5,
        overageCharges: 0.82,
        currency: "USD",
      },
    });

    expect(rendered).toContain("102.0% used · 1020.50 / 1000");
    expect(rendered).toContain("overage 20.50 (0.82 USD)");
    // No reset date in the payload, so the trailing line is the manage link alone.
    expect(rendered.endsWith("  https://app.kiro.dev/account/usage")).toBe(true);
  });

  it("says so when the control plane returns no buckets", () => {
    expect(formatKiroUsage({ subscriptionInfo: { subscriptionTitle: "KIRO FREE" } })).toBe(
      "Kiro — KIRO FREE\n  no usage data returned",
    );
  });
});
