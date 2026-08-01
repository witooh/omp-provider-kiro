import { describe, expect, it } from "bun:test";
import type { Api, Model, ThinkingConfig } from "@oh-my-pi/pi-ai";
import {
  buildKiroAdditionalModelRequestFields,
  deriveKiroEffort,
  fallbackKiroEffort,
  getKiroEffortConfig,
  type KiroEffortLevel,
  mapPiLevelToKiroEffort,
} from "../src/effort.js";

type EffortModel = Model<Api> & {
  additionalModelRequestFieldsSchema?: unknown;
};

function model(overrides: Partial<EffortModel> = {}): EffortModel {
  return {
    id: "test",
    name: "test",
    api: "kiro-api",
    provider: "kiro",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    compat: undefined,
    ...overrides,
  };
}

function schema(field: "reasoning" | "output_config", values: string[], summarized = false): unknown {
  return {
    type: "object",
    properties: {
      [field]: {
        type: "object",
        properties: { effort: { type: "string", enum: values } },
      },
      ...(summarized
        ? {
            thinking: {
              type: "object",
              properties: { display: { type: "string", enum: ["summarized"] } },
            },
          }
        : {}),
    },
  };
}

describe("effort", () => {
  describe("deriveKiroEffort", () => {
    it("reads reasoning.effort enum", () => {
      expect(deriveKiroEffort(schema("reasoning", ["low", "high"]))).toEqual({
        field: "reasoning",
        values: ["low", "high"],
        summarizedThinking: false,
      });
    });

    it("reads output_config and summarized thinking display", () => {
      expect(deriveKiroEffort(schema("output_config", ["low", "max"], true))).toEqual({
        field: "output_config",
        values: ["low", "max"],
        summarizedThinking: true,
      });
    });

    it("returns undefined for junk", () => {
      expect(deriveKiroEffort(null)).toBeUndefined();
      expect(deriveKiroEffort({ properties: {} })).toBeUndefined();
    });
  });

  describe("fallbackKiroEffort", () => {
    it("classifies known model families", () => {
      expect(fallbackKiroEffort("openai-gpt-5.2")?.field).toBe("reasoning");
      expect(fallbackKiroEffort("claude-opus-4.7")?.values).toContain("xhigh");
      expect(fallbackKiroEffort("claude-sonnet-4.6")?.values).toEqual(["low", "medium", "high", "max"]);
      expect(fallbackKiroEffort("claude-sonnet-4-6")?.values).toEqual(["low", "medium", "high", "max"]);
      expect(fallbackKiroEffort("deepseek-3.2")).toBeUndefined();
    });
  });

  describe("getKiroEffortConfig", () => {
    it("prefers schema over known-model fallback", () => {
      const m = model({
        additionalModelRequestFieldsSchema: schema("reasoning", ["low"]),
      });
      // Known-model fallback would be output_config for sonnet-4.6; schema wins.
      expect(getKiroEffortConfig(m, "claude-sonnet-4.6")?.field).toBe("reasoning");
    });

    it("falls back when schema metadata is absent", () => {
      expect(getKiroEffortConfig(model(), "claude-sonnet-4.6")?.field).toBe("output_config");
    });

    it("does not invent fallback when schema is present but empty", () => {
      const m = model({ additionalModelRequestFieldsSchema: { properties: {} } });
      expect(getKiroEffortConfig(m, "claude-sonnet-4.6")).toBeUndefined();
    });
  });

  describe("mapPiLevelToKiroEffort", () => {
    const config = {
      field: "output_config" as const,
      values: ["low", "medium", "high", "max"],
      summarizedThinking: false,
    };

    it("maps minimal to low and empty enum to undefined", () => {
      expect(mapPiLevelToKiroEffort("minimal", config)).toBe("low");
      expect(mapPiLevelToKiroEffort("high", { ...config, values: [] })).toBeUndefined();
    });

    it("returns the level unchanged when the Kiro enum already has it", () => {
      expect(mapPiLevelToKiroEffort("high", config)).toBe("high");
    });

    it("steps down when the level is missing from the Kiro enum", () => {
      const onlyLowMed = { ...config, values: ["low", "medium"] };
      expect(mapPiLevelToKiroEffort("high", onlyLowMed)).toBe("medium");
    });

    it("steps up from xhigh to max when the Kiro enum skips xhigh", () => {
      expect(mapPiLevelToKiroEffort("xhigh", config)).toBe("max");
    });
  });

  describe("buildKiroAdditionalModelRequestFields", () => {
    it("builds reasoning field for GPT-style schemas", () => {
      const thinking = {
        mode: "effort" as const,
        efforts: ["minimal", "low", "medium", "high", "xhigh"] as ThinkingConfig["efforts"],
      };
      const m = model({
        additionalModelRequestFieldsSchema: schema("reasoning", ["low", "medium", "high", "xhigh"]),
        thinking,
      });
      const level: KiroEffortLevel = "xhigh";
      expect(buildKiroAdditionalModelRequestFields(m, "openai-gpt-5.2", level)).toEqual({
        reasoning: { effort: "xhigh" },
      });
    });

    it("builds output_config with optional summarized display", () => {
      const m = model({
        additionalModelRequestFieldsSchema: schema("output_config", ["low", "max"], true),
      });
      const level: KiroEffortLevel = "max";
      expect(buildKiroAdditionalModelRequestFields(m, "claude-opus-4.7", level)).toEqual({
        output_config: { effort: "max" },
        thinking: { type: "adaptive", display: "summarized" },
      });
    });

    it("returns undefined when level or reasoning is missing", () => {
      expect(buildKiroAdditionalModelRequestFields(model(), "claude-sonnet-4.6", undefined)).toBeUndefined();
      const level: KiroEffortLevel = "high";
      expect(
        buildKiroAdditionalModelRequestFields(model({ reasoning: false }), "claude-sonnet-4.6", level),
      ).toBeUndefined();
    });
  });
});
