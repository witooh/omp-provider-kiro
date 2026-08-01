import { describe, expect, it } from "bun:test";
import type { KiroCredentials } from "../src/oauth.js";
import { refreshKiroToken } from "../src/oauth.js";
import { vi } from "./vi.js";

// Mock kiro-cli to prevent fallback to real credentials
vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: vi.fn(() => undefined),
  getKiroCliCredentialsAllowExpired: vi.fn(() => undefined),
  getKiroCliSocialToken: vi.fn(() => undefined),
  saveKiroCliCredentials: vi.fn(),
}));

describe("Feature 3: OAuth — Token Refresh", () => {
  // Interactive login / device code flow tests live in test/login.test.ts (Feature 10)

  describe("refreshKiroToken", () => {
    it("refreshes token using encoded refresh field", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
      });
      expect(creds.access).toBe("new_at");
      expect(creds.refresh).toContain("new_rt|cid|csec|idc");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.clientId).toBe("cid");
      expect(body.refreshToken).toBe("old_rt");
      vi.unstubAllGlobals();
    });

    it("refreshes against the SSO region packed into the refresh string", async () => {
      // omp's credential store drops `region`, so a refresh that trusts the credential
      // object alone always hits us-east-1 and AWS rejects the token permanently.
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc|ap-southeast-1",
        access: "old_at",
        expires: 0,
      });

      expect(mockFetch.mock.calls[0][0]).toBe("https://oidc.ap-southeast-1.amazonaws.com/token");
      expect(creds.refresh).toBe("new_rt|cid|csec|idc|ap-southeast-1");
      vi.unstubAllGlobals();
    });

    it("falls back to us-east-1 for refresh strings written before regions were packed", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await refreshKiroToken({ refresh: "old_rt|cid|csec|idc", access: "old_at", expires: 0 });

      expect(mockFetch.mock.calls[0][0]).toBe("https://oidc.us-east-1.amazonaws.com/token");
      vi.unstubAllGlobals();
    });

    it("throws on failed refresh", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      await expect(refreshKiroToken({ refresh: "rt|c|s|idc", access: "x", expires: 0 })).rejects.toThrow();
      vi.unstubAllGlobals();
    });

    it("refreshes desktop tokens via Kiro auth service", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "desk_at", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "desk_rt|desktop",
        access: "old",
        expires: 0,
        region: "us-east-1",
      } as KiroCredentials);
      expect(creds.access).toBe("desk_at");
      expect(creds.refresh).toContain("desk_rt|desktop");
      expect((creds as KiroCredentials).authMethod).toBe("desktop");

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("auth.desktop.kiro.dev/refreshToken");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.refreshToken).toBe("desk_rt");
      expect(body.clientId).toBeUndefined();
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }));
      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as KiroCredentials),
      ).rejects.toThrow("Desktop token refresh failed: 401");
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh with missing accessToken", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ expiresIn: 3600 }) }),
      );
      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as KiroCredentials),
      ).rejects.toThrow("Desktop token refresh: missing accessToken");
      vi.unstubAllGlobals();
    });

    it("uses region from credentials for IDC refresh", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
        region: "us-west-2",
      } as KiroCredentials);

      expect(mockFetch.mock.calls[0][0]).toContain("oidc.us-west-2.amazonaws.com");
      vi.unstubAllGlobals();
    });

    it("uses expired kiro-cli creds as fallback when direct refresh fails", async () => {
      const { getKiroCliCredentialsAllowExpired } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliCredentialsAllowExpired).mockReturnValueOnce({
        refresh: "cli_rt|cli_cid|cli_csec|idc",
        access: "cli_at",
        expires: Date.now() - 1000,
        clientId: "cli_cid",
        clientSecret: "cli_csec",
        region: "us-east-1",
        authMethod: "idc",
      });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({ refresh: "stale_rt|cid|csec|idc", access: "stale_at", expires: 0 });
      expect(creds.access).toBe("new_at");
      vi.unstubAllGlobals();
    });

    it("falls through to graceful degradation when expired creds refresh also fails", async () => {
      const { getKiroCliCredentialsAllowExpired } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliCredentialsAllowExpired).mockReturnValueOnce({
        refresh: "cli_rt|cli_cid|cli_csec|idc",
        access: "cli_at",
        expires: Date.now() - 1000,
        clientId: "cli_cid",
        clientSecret: "cli_csec",
        region: "us-east-1",
        authMethod: "idc",
      });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false, status: 401 });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: Date.now() - 60_000,
      });
      expect(creds.access).toBe("old_at");
      expect(creds.expires).toBeGreaterThan(Date.now());
      vi.unstubAllGlobals();
    });
  });
});
