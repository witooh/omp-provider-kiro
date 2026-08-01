import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { toolWireSchema, z } from "@oh-my-pi/pi-ai";
import {
  assistantContentToKiro,
  buildHistory,
  convertImagesToKiro,
  convertToolsToKiro,
  getContentText,
  normalizeMessages,
  normalizeToolIds,
  parseToolCallArguments,
  sanitizeSurrogates,
  TOOL_RESULT_LIMIT,
  toolResultToKiro,
  truncate,
} from "../src/transform.js";

const ts = Date.now();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content: string): UserMessage => ({ role: "user", content, timestamp: ts });
const assistant = (text: string, opts?: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "kiro-api",
  provider: "kiro",
  model: "test",
  usage,
  stopReason: "stop",
  timestamp: ts,
  ...opts,
});
const toolResult = (id: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "t",
  content: [{ type: "text", text }],
  isError,
  timestamp: ts,
});

describe("Feature 5: Message Transformation", () => {
  describe("sanitizeSurrogates", () => {
    it("removes unpaired high surrogate", () => {
      expect(sanitizeSurrogates("a\uD800b")).toBe("ab");
    });
    it("removes unpaired low surrogate", () => {
      expect(sanitizeSurrogates("a\uDC00b")).toBe("ab");
    });
    it("preserves properly paired surrogates (emoji)", () => {
      expect(sanitizeSurrogates("Hello 🙈 World")).toBe("Hello 🙈 World");
    });
    it("leaves normal text unchanged", () => {
      expect(sanitizeSurrogates("hello")).toBe("hello");
    });
  });

  describe("truncate", () => {
    it("returns text unchanged if under limit", () => {
      expect(truncate("short", 100)).toBe("short");
    });
    it("truncates with marker when over limit", () => {
      const r = truncate("a".repeat(100), 50);
      expect(r).toContain("[TRUNCATED]");
      expect(r.length).toBeLessThan(100);
    });
    it("preserves start and end", () => {
      const r = truncate(`START${"x".repeat(100)}END`, 30);
      expect(r).toMatch(/^START/);
      expect(r).toMatch(/END$/);
    });
  });

  describe("normalizeMessages", () => {
    it("filters errored assistant messages", () => {
      const msgs: Message[] = [user("hi"), assistant("oops", { stopReason: "error" }), user("retry")];
      expect(normalizeMessages(msgs)).toHaveLength(2);
    });
    it("filters aborted assistant messages", () => {
      expect(normalizeMessages([user("hi"), assistant("x", { stopReason: "aborted" })])).toHaveLength(1);
    });
    it("keeps successful assistant messages", () => {
      expect(normalizeMessages([user("hi"), assistant("ok")])).toHaveLength(2);
    });
  });

  describe("normalizeToolIds", () => {
    // grok-cli shape: 86 chars with a pipe. Kiro rejects it on either count.
    const GROK_ID = "call-4af9e987-d9d6-47da-96a6-9b1f0b66f29d-55|fc_200a6eeb-1e79-944e-bddb-66747a4957e4_0";

    const toolCall = (id: string, name = "bash") => ({ type: "toolCall" as const, id, name, arguments: {} });

    const assistantWithCalls = (...calls: ReturnType<typeof toolCall>[]): AssistantMessage => ({
      ...assistant(""),
      content: calls,
      stopReason: "toolUse",
    });

    const idsOf = (messages: Message[]): string[] =>
      messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.filter((c) => c.type === "toolCall").map((c) => c.id)
          : m.role === "toolResult"
            ? [m.toolCallId]
            : [],
      );

    it("rewrites a call and its result to the same provider-safe id", () => {
      const out = normalizeToolIds([assistantWithCalls(toolCall(GROK_ID)), toolResult(GROK_ID, "ok")]);
      const [callId, resultId] = idsOf(out);
      expect(callId).toBe(resultId);
      expect(callId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    });

    it("keeps distinct originals distinct", () => {
      const out = normalizeToolIds([assistantWithCalls(toolCall("a|b"), toolCall("c|d"))]);
      const [first, second] = idsOf(out);
      expect(first).not.toBe(second);
    });

    it("leaves already-safe ids untouched, rewriting only what fails", () => {
      const out = normalizeToolIds([assistantWithCalls(toolCall("t1"), toolCall("a|b"))]);
      expect(idsOf(out)[0]).toBe("t1");
      expect(idsOf(out)[1]).not.toBe("a|b");
    });

    it("rewrites an id that is too long even without a bad character", () => {
      const tooLong = "a".repeat(65);
      expect(idsOf(normalizeToolIds([assistantWithCalls(toolCall(tooLong))]))[0]).not.toBe(tooLong);
    });

    it("accepts an id of exactly the length limit", () => {
      const atLimit = "a".repeat(64);
      expect(idsOf(normalizeToolIds([assistantWithCalls(toolCall(atLimit))]))[0]).toBe(atLimit);
    });

    it("does not mint an id that already exists in the branch", () => {
      const out = normalizeToolIds([assistantWithCalls(toolCall("tool_0"), toolCall("a|b"))]);
      const [kept, minted] = idsOf(out);
      expect(kept).toBe("tool_0");
      expect(minted).not.toBe("tool_0");
    });

    it("returns the same array reference when every id already passes", () => {
      const messages: Message[] = [assistantWithCalls(toolCall("t1")), toolResult("t1", "ok")];
      expect(normalizeToolIds(messages)).toBe(messages);
    });

    it("handles an empty branch", () => {
      const messages: Message[] = [];
      expect(normalizeToolIds(messages)).toBe(messages);
    });

    it("rewrites . and : the same way as |", () => {
      for (const bad of ["abc.def", "abc:def"]) {
        const out = idsOf(normalizeToolIds([assistantWithCalls(toolCall(bad))]))[0];
        expect(out).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(out).not.toBe(bad);
      }
    });
  });

  describe("getContentText", () => {
    it("extracts from user string", () => {
      expect(getContentText(user("hello"))).toBe("hello");
    });
    it("extracts from tool result", () => {
      expect(getContentText(toolResult("tc1", "result"))).toBe("result");
    });
    it("extracts from assistant with thinking+text", () => {
      const msg = assistant("");
      msg.content = [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ];
      const text = getContentText(msg);
      expect(text).toContain("hmm");
      expect(text).toContain("answer");
    });
  });

  describe("convertToolsToKiro", () => {
    it("emits the wire JSON Schema for plain-object parameters", () => {
      const tools: Tool[] = [
        {
          name: "bash",
          description: "Run cmd",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ];
      const r = convertToolsToKiro(tools);
      expect(r[0].toolSpecification.name).toBe("bash");
      expect(r[0].toolSpecification.inputSchema.json).toEqual(toolWireSchema(tools[0]));
    });

    it("converts Zod parameters to JSON Schema instead of leaking Zod internals", () => {
      const tools: Tool[] = [
        {
          name: "read",
          description: "Read a file",
          parameters: z.object({ path: z.string().describe("file path") }),
        },
      ];
      const json = convertToolsToKiro(tools)[0].toolSpecification.inputSchema.json;
      expect(json.type).toBe("object");
      expect((json.properties as Record<string, unknown>).path).toEqual({ type: "string", description: "file path" });
      expect(JSON.stringify(json)).not.toContain("_zod");
    });
  });

  describe("convertImagesToKiro", () => {
    it("converts images with format from mimeType", () => {
      const r = convertImagesToKiro([{ mimeType: "image/png", data: "b64" }]);
      expect(r[0]).toEqual({ format: "png", source: { bytes: "b64" } });
    });
  });

  describe("parseToolCallArguments / assistantContentToKiro / toolResultToKiro", () => {
    it("parses object and string args", () => {
      expect(parseToolCallArguments({ cmd: "ls" })).toEqual({ cmd: "ls" });
      expect(parseToolCallArguments('{"cmd":"ls"}')).toEqual({ cmd: "ls" });
    });

    it("returns empty object for invalid JSON instead of throwing", () => {
      expect(parseToolCallArguments("{not json")).toEqual({});
    });

    it("builds arm content with thinking, text, and tool uses", () => {
      const { content, toolUses } = assistantContentToKiro([
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "hi" },
        // runtime may still carry string args even when types say Record
        { type: "toolCall", id: "t1", name: "bash", arguments: "{bad" as unknown as Record<string, unknown> },
      ]);
      expect(content).toContain("<thinking>plan</thinking>");
      expect(content).toContain("hi");
      expect(toolUses).toEqual([{ name: "bash", toolUseId: "t1", input: {} }]);
    });

    it("maps tool results including errors", () => {
      expect(toolResultToKiro(toolResult("t1", "ok"), 100)).toEqual({
        content: [{ text: "ok" }],
        status: "success",
        toolUseId: "t1",
      });
      expect(toolResultToKiro(toolResult("t2", "boom", true), 100).status).toBe("error");
    });

    it("buildHistory survives bad tool-call argument JSON", () => {
      const msgs: Message[] = [
        user("hi"),
        {
          ...assistant(""),
          content: [
            {
              type: "toolCall",
              id: "t1",
              name: "bash",
              arguments: "{bad" as unknown as Record<string, unknown>,
            },
          ],
          stopReason: "toolUse",
        },
        toolResult("t1", "done"),
        user("next"),
      ];
      expect(() => buildHistory(msgs, "m")).not.toThrow();
      const { history } = buildHistory(msgs, "m");
      const arm = history.find((e) => e.assistantResponseMessage)?.assistantResponseMessage;
      expect(arm?.toolUses?.[0].input).toEqual({});
    });
  });

  describe("buildHistory", () => {
    it("returns empty history for single user message", () => {
      const { history } = buildHistory([user("Hello")], "M");
      expect(history).toHaveLength(0);
    });

    it("prepends system prompt to first user message", () => {
      const msgs: Message[] = [user("first"), assistant("reply"), user("second")];
      const { history, systemPrepended } = buildHistory(msgs, "M", "Be helpful");
      expect(systemPrepended).toBe(true);
      expect(history[0].userInputMessage?.content).toMatch(/^Be helpful/);
    });

    it("converts assistant tool calls", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "ok"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.assistantResponseMessage?.toolUses);
      expect(entry?.assistantResponseMessage?.toolUses?.[0].name).toBe("bash");
    });

    it("batches consecutive tool results", () => {
      const a = assistant("");
      a.content = [
        { type: "toolCall", id: "tc1", name: "a", arguments: {} },
        { type: "toolCall", id: "tc2", name: "b", arguments: {} },
      ];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "r1"), toolResult("tc2", "r2"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      expect(entry?.userInputMessage?.userInputMessageContext?.toolResults).toHaveLength(2);
    });

    it("truncates tool results exceeding limit", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      const msgs: Message[] = [user("go"), a, toolResult("tc1", "x".repeat(TOOL_RESULT_LIMIT + 1000)), user("next")];
      const { history } = buildHistory(msgs, "M");
      const entry = history.find((h) => h.userInputMessage?.userInputMessageContext?.toolResults);
      const text = entry?.userInputMessage?.userInputMessageContext?.toolResults?.[0].content[0].text ?? "";
      expect(text).toContain("[TRUNCATED]");
    });

    it("merges consecutive user messages instead of inserting synthetic padding", () => {
      const msgs: Message[] = [user("first"), user("second"), assistant("reply"), user("third")];
      const { history } = buildHistory(msgs, "M");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No synthetic assistant padding — consecutive users are merged
      const assistantPadding = history.filter(
        (h) =>
          h.assistantResponseMessage &&
          !h.assistantResponseMessage.toolUses &&
          h.assistantResponseMessage.content.length > 0 &&
          h.assistantResponseMessage.content.length <= 3,
      );
      expect(assistantPadding).toHaveLength(0);
      // First user message should contain both user contents merged
      expect(history[0].userInputMessage?.content).toContain("first");
      expect(history[0].userInputMessage?.content).toContain("second");
    });

    it("merges tool results into previous user message instead of inserting synthetic padding", () => {
      const a = assistant("");
      a.content = [{ type: "toolCall", id: "tc1", name: "a", arguments: {} }];
      // user -> user(tool results) — should merge, not pad
      const msgs: Message[] = [user("go"), user("more"), a, toolResult("tc1", "ok"), user("next")];
      const { history } = buildHistory(msgs, "M");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No synthetic padding entries
      const assistantPadding = history.filter(
        (h) =>
          h.assistantResponseMessage &&
          !h.assistantResponseMessage.toolUses &&
          h.assistantResponseMessage.content.length > 0 &&
          h.assistantResponseMessage.content.length <= 3,
      );
      expect(assistantPadding).toHaveLength(0);
    });

    it("never contains synthetic padding in long agentic sessions", () => {
      const msgs: Message[] = [user("start")];
      for (let i = 0; i < 20; i++) {
        const a = assistant(`step ${i}`);
        a.content = [{ type: "toolCall", id: `tc${i}`, name: "bash", arguments: { cmd: "ls" } }];
        msgs.push(a);
        msgs.push(toolResult(`tc${i}`, `output ${i}`));
      }
      msgs.push(user("done"));
      const { history } = buildHistory(msgs, "M", "Be helpful");
      const json = JSON.stringify(history);
      expect(json).not.toContain('"Continue"');
      // No single-char synthetic padding
      const padding = history.filter(
        (h) =>
          (h.assistantResponseMessage &&
            h.assistantResponseMessage.content.length > 0 &&
            h.assistantResponseMessage.content.length <= 3 &&
            !h.assistantResponseMessage.toolUses) ||
          (h.userInputMessage &&
            h.userInputMessage.content.length > 0 &&
            h.userInputMessage.content.length <= 3 &&
            !h.userInputMessage.userInputMessageContext?.toolResults),
      );
      expect(padding).toHaveLength(0);
    });

    it("maintains valid alternating user/assistant pattern via merging", () => {
      const msgs: Message[] = [user("a"), user("b"), user("c"), assistant("reply"), user("d")];
      const { history } = buildHistory(msgs, "M");
      for (let i = 0; i < history.length - 1; i++) {
        const curr = history[i];
        const next = history[i + 1];
        // No two consecutive user or assistant entries
        if (curr.userInputMessage) expect(next.assistantResponseMessage).toBeDefined();
        if (curr.assistantResponseMessage) expect(next.userInputMessage).toBeDefined();
      }
    });
  });
});
