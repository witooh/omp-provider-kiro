// Feature 5: Message Transformation

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai";

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolUse {
  name: string;
  toolUseId: string;
  input: Record<string, unknown>;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: "success" | "error";
  toolUseId: string;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}
export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "KIRO_CLI";
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: KiroToolSpec[] };
}
export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export const TOOL_RESULT_LIMIT = 250000;

export function sanitizeSurrogates(text: string): string {
  // Replace unpaired high surrogates (0xD800-0xDBFF not followed by low surrogate)
  // Replace unpaired low surrogates (0xDC00-0xDFFF not preceded by high surrogate)
  // Properly paired surrogates (e.g. emoji like 🙈) are preserved.
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.substring(0, half)}\n... [TRUNCATED] ...\n${text.substring(text.length - half)}`;
}

export function normalizeMessages(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    const am = msg as AssistantMessage;
    return am.stopReason !== "error" && am.stopReason !== "aborted";
  });
}

/** Bedrock toolUseId: ^[A-Za-z0-9_-]{1,64}$ — Kiro rejects anything else with 400. */
const PROVIDER_SAFE_TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Rewrite tool-call ids that Kiro would reject.
 *
 * Cross-provider branches carry foreign ids (e.g. grok's
 * `call-<uuid>-NN|fc_<uuid>_N` — 86 chars with a pipe). Kiro enforces
 * Bedrock's toolUseId pattern; violations answer REQUEST_BODY_INVALID.
 *
 * One pass over the whole Message[] so a call in history and its result in
 * the current message stay paired. Outbound only — Kiro-minted inbound ids
 * already match the regex. Same-reference return when every id already passes.
 */
export function normalizeToolIds(messages: Message[]): Message[] {
  const taken = new Set<string>();
  for (const message of messages) {
    if (message.role === "toolResult") taken.add(message.toolCallId);
    else if (message.role === "assistant") {
      for (const c of message.content) if (c.type === "toolCall") taken.add(c.id);
    }
  }

  const rewritten = new Map<string, string>();
  let counter = 0;
  const rename = (id: string): string => {
    if (PROVIDER_SAFE_TOOL_ID.test(id)) return id;
    const existing = rewritten.get(id);
    if (existing) return existing;
    while (taken.has(`tool_${counter}`)) counter++;
    const safe = `tool_${counter++}`;
    rewritten.set(id, safe);
    return safe;
  };

  const out = messages.map((message) => {
    if (message.role === "toolResult") {
      const id = rename(message.toolCallId);
      return id === message.toolCallId ? message : { ...message, toolCallId: id };
    }
    if (message.role !== "assistant") return message;
    let touched = false;
    const content = message.content.map((c) => {
      if (c.type !== "toolCall") return c;
      const id = rename(c.id);
      if (id === c.id) return c;
      touched = true;
      return { ...c, id };
    });
    return touched ? { ...message, content } : message;
  });

  return rewritten.size === 0 ? messages : out;
}

export function extractImages(msg: Message): ImageContent[] {
  if (msg.role === "toolResult" || typeof msg.content === "string") return [];
  if (!Array.isArray(msg.content)) return [];
  // The user/assistant content unions defeat `filter`'s type-predicate overload.
  const parts: readonly { type: string }[] = msg.content;
  return parts.filter((c): c is ImageContent => c.type === "image");
}

export function getContentText(msg: Message): string {
  if (msg.role === "toolResult") return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

export function convertToolsToKiro(tools: Tool[]): KiroToolSpec[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: toolWireSchema(tool) },
    },
  }));
}

export function convertImagesToKiro(images: Array<{ mimeType: string; data: string }>): KiroImage[] {
  return images.map((img) => ({ format: img.mimeType.split("/")[1] || "png", source: { bytes: img.data } }));
}

/** Parse tool-call arguments; bad JSON becomes {} so one bad call cannot kill the request. */
export function parseToolCallArguments(args: unknown): Record<string, unknown> {
  if (typeof args !== "string") return (args ?? {}) as Record<string, unknown>;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Convert assistant content blocks into a Kiro assistantResponseMessage body. */
export function assistantContentToKiro(content: AssistantMessage["content"]): {
  content: string;
  toolUses: KiroToolUse[];
} {
  let armContent = "";
  const toolUses: KiroToolUse[] = [];
  if (!Array.isArray(content)) return { content: armContent, toolUses };
  for (const block of content) {
    if (block.type === "text") armContent += (block as TextContent).text;
    else if (block.type === "thinking")
      armContent = `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n${armContent}`;
    else if (block.type === "toolCall") {
      const tc = block as ToolCall;
      toolUses.push({
        name: tc.name,
        toolUseId: tc.id,
        input: parseToolCallArguments(tc.arguments),
      });
    }
  }
  return { content: armContent, toolUses };
}

export function toolResultToKiro(msg: ToolResultMessage, limit: number): KiroToolResult {
  return {
    content: [{ text: truncate(getContentText(msg), limit) }],
    status: msg.isError ? "error" : "success",
    toolUseId: msg.toolCallId,
  };
}

export function extractToolResultImages(msg: ToolResultMessage): ImageContent[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function buildHistory(
  messages: Message[],
  modelId: string,
  systemPrompt?: string,
): { history: KiroHistoryEntry[]; systemPrepended: boolean; currentMsgStartIdx: number } {
  const history: KiroHistoryEntry[] = [];
  let systemPrepended = false;
  const toolResultLimit = TOOL_RESULT_LIMIT;

  let currentMsgStartIdx = messages.length - 1;
  while (currentMsgStartIdx > 0 && messages[currentMsgStartIdx].role === "toolResult") currentMsgStartIdx--;
  if (currentMsgStartIdx >= 0 && messages[currentMsgStartIdx].role === "assistant") {
    const am = messages[currentMsgStartIdx] as AssistantMessage;
    if (!Array.isArray(am.content) || !am.content.some((b) => b.type === "toolCall")) currentMsgStartIdx++;
  }

  const historyMessages = messages.slice(0, currentMsgStartIdx);

  for (let i = 0; i < historyMessages.length; i++) {
    const msg = historyMessages[i];
    if (msg.role === "user") {
      let content = typeof msg.content === "string" ? msg.content : getContentText(msg);
      if (systemPrompt && !systemPrepended) {
        content = `${systemPrompt}\n\n${content}`;
        systemPrepended = true;
      }
      const images = extractImages(msg);
      const uim: KiroUserInputMessage = {
        content: sanitizeSurrogates(content),
        modelId,
        origin: "KIRO_CLI",
        ...(images.length > 0 ? { images: convertImagesToKiro(images) } : {}),
      };
      const lastEntryForUim = history[history.length - 1];
      const prevUim = lastEntryForUim?.userInputMessage;
      if (prevUim) {
        // Merge into previous user message to maintain alternation without synthetic padding
        prevUim.content += `\n\n${uim.content}`;
        if (uim.images) prevUim.images = [...(prevUim.images || []), ...uim.images];
      } else {
        history.push({ userInputMessage: uim });
      }
    } else if (msg.role === "assistant") {
      const { content: armContent, toolUses: armToolUses } = assistantContentToKiro(msg.content);
      if (!armContent && armToolUses.length === 0) continue;
      history.push({
        assistantResponseMessage: { content: armContent, ...(armToolUses.length > 0 ? { toolUses: armToolUses } : {}) },
      });
    } else if (msg.role === "toolResult") {
      const trMsg = msg as ToolResultMessage;
      const toolResults: KiroToolResult[] = [toolResultToKiro(trMsg, toolResultLimit)];
      const trImages = extractToolResultImages(trMsg);
      let j = i + 1;
      while (j < historyMessages.length && historyMessages[j].role === "toolResult") {
        const next = historyMessages[j] as ToolResultMessage;
        toolResults.push(toolResultToKiro(next, toolResultLimit));
        trImages.push(...extractToolResultImages(next));
        j++;
      }
      i = j - 1;
      const lastEntryForTr = history[history.length - 1];
      const prevTr = lastEntryForTr?.userInputMessage;
      if (prevTr) {
        // Merge tool results into previous user message to maintain alternation without synthetic padding
        prevTr.content += "\n\nTool results provided.";
        if (trImages.length > 0) prevTr.images = [...(prevTr.images || []), ...convertImagesToKiro(trImages)];
        if (!prevTr.userInputMessageContext) prevTr.userInputMessageContext = {};
        prevTr.userInputMessageContext.toolResults = [
          ...(prevTr.userInputMessageContext.toolResults || []),
          ...toolResults,
        ];
      } else {
        history.push({
          userInputMessage: {
            content: "Tool results provided.",
            modelId,
            origin: "KIRO_CLI",
            ...(trImages.length > 0 ? { images: convertImagesToKiro(trImages) } : {}),
            userInputMessageContext: { toolResults },
          },
        });
      }
    }
  }
  return { history, systemPrepended, currentMsgStartIdx };
}
