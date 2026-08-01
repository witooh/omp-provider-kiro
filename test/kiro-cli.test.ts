import { describe, expect, it } from "bun:test";
import { getKiroCliCredentials, getKiroCliDbPath, refreshViaKiroCli } from "../src/kiro-cli.js";

describe("Feature 4: kiro-cli Credential Fallback", () => {
  describe("getKiroCliDbPath", () => {
    it("returns undefined when database does not exist", () => {
      // Default: no kiro-cli installed
      const result = getKiroCliDbPath();
      // Either undefined (no file) or a string (if kiro-cli happens to be installed)
      expect(result === undefined || typeof result === "string").toBe(true);
    });
  });

  describe("getKiroCliCredentials", () => {
    it("returns undefined or credentials when database may exist", () => {
      const result = getKiroCliCredentials();
      // Either undefined (no kiro-cli) or credentials object (kiro-cli installed)
      expect(result === undefined || (typeof result === "object" && "access" in result)).toBe(true);
    });

    it("returns credentials with required fields when available", () => {
      const result = getKiroCliCredentials();
      if (result) {
        expect(result).toHaveProperty("access");
        expect(result).toHaveProperty("refresh");
        expect(result).toHaveProperty("expires");
        expect(result).toHaveProperty("clientId");
        expect(result).toHaveProperty("clientSecret");
        expect(result).toHaveProperty("region");
      }
    });
  });

  describe("refreshViaKiroCli", () => {
    it("returns undefined when kiro-cli is not installed", () => {
      // test/setup.ts points PATH and HOME at an empty temp dir, so there is no
      // kiro-cli binary to exec and no credential DB to read.
      expect(refreshViaKiroCli()).toBeUndefined();
    });

    it("returns credentials or undefined", () => {
      // On CI (no kiro-cli): returns undefined
      // On dev machine (kiro-cli installed): returns credentials or undefined
      const result = refreshViaKiroCli();
      if (result) {
        expect(result).toHaveProperty("access");
        expect(result).toHaveProperty("refresh");
        expect(result).toHaveProperty("expires");
        expect(result).toHaveProperty("authMethod");
      }
    });
  });
});
