import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../../../lib/storage", () => ({ downloadFile: vi.fn() }));

import type { Db } from "../../../lib/supabase";
import {
  attachPriorReasoning,
  buildMessages,
  MAX_REPLAYED_REASONING_CHARS,
} from "./contextBuilders";
import type { ChatMessage } from "./types";

type Row = { content: unknown };

/** Records the query it is given and resolves with the supplied rows. */
function makeDb(rows: Row[], error: unknown = null) {
  const calls: { table?: string; filters: Record<string, unknown> } = {
    filters: {},
  };
  const db = {
    from: (table: string) => {
      calls.table = table;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          calls.filters[column] = value;
          return b;
        },
        not: () => b,
        order: (column: string, opts: unknown) => {
          calls.filters[`order:${column}`] = opts;
          return b;
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: error ? null : rows, error }),
      };
      return b;
    },
  };
  return { db: db as unknown as Db, calls };
}

const turn = (...events: { type: string; text: string }[]): Row => ({
  content: events,
});

describe("attachPriorReasoning", () => {
  it("attaches each stored turn's reasoning to the matching assistant message", async () => {
    const { db, calls } = makeDb([
      turn(
        { type: "reasoning", text: "Plan the answer." },
        { type: "content", text: "First " },
        { type: "content", text: "answer." },
      ),
      turn(
        { type: "reasoning", text: "Read the clause." },
        { type: "doc_read", text: "ignored" },
        { type: "reasoning", text: "Summarise it." },
        { type: "content", text: "Second answer." },
      ),
    ]);
    const messages: ChatMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "q2" },
      { role: "assistant", content: "Second answer." },
      { role: "user", content: "q3" },
    ];

    const result = await attachPriorReasoning(messages, "chat-1", db);

    expect(calls.table).toBe("chat_messages");
    expect(calls.filters).toMatchObject({ chat_id: "chat-1", role: "assistant" });
    expect(result.map((m) => m.reasoning)).toEqual([
      undefined,
      "Plan the answer.",
      undefined,
      "Read the clause.\n\nSummarise it.",
      undefined,
    ]);
    // The visible history is untouched.
    expect(result.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it("matches in order, so repeated replies each get their own turn's reasoning", async () => {
    const { db } = makeDb([
      turn({ type: "reasoning", text: "r1" }, { type: "content", text: "Done." }),
      turn({ type: "reasoning", text: "r2" }, { type: "content", text: "Done." }),
    ]);
    const result = await attachPriorReasoning(
      [
        { role: "assistant", content: "Done." },
        { role: "assistant", content: "Done." },
      ],
      "chat-1",
      db,
    );
    expect(result.map((m) => m.reasoning)).toEqual(["r1", "r2"]);
  });

  it("leaves a message without a matching stored turn alone", async () => {
    const { db } = makeDb([
      turn({ type: "reasoning", text: "r1" }, { type: "content", text: "Stored." }),
    ]);
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Edited by the client." },
    ];
    const result = await attachPriorReasoning(messages, "chat-1", db);
    expect(result[0].reasoning).toBeUndefined();
  });

  it("keeps only the tail of very long reasoning", async () => {
    const long = `${"a".repeat(MAX_REPLAYED_REASONING_CHARS)}END`;
    const { db } = makeDb([
      turn({ type: "reasoning", text: long }, { type: "content", text: "Answer." }),
    ]);
    const [message] = await attachPriorReasoning(
      [{ role: "assistant", content: "Answer." }],
      "chat-1",
      db,
    );
    expect(message.reasoning).toHaveLength(MAX_REPLAYED_REASONING_CHARS);
    expect(message.reasoning?.endsWith("END")).toBe(true);
  });

  it("reads the table it is given", async () => {
    const { db, calls } = makeDb([]);
    await attachPriorReasoning(
      [{ role: "assistant", content: "x" }],
      "chat-1",
      db,
      "word_chat_messages",
    );
    expect(calls.table).toBe("word_chat_messages");
  });

  it("returns the history unchanged without a chat, an assistant turn, or a readable table", async () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "Answer." }];
    const stored = [
      turn({ type: "reasoning", text: "r" }, { type: "content", text: "Answer." }),
    ];

    const noChat = makeDb(stored);
    expect(await attachPriorReasoning(messages, null, noChat.db)).toBe(messages);
    expect(noChat.calls.table).toBeUndefined();

    const userOnly: ChatMessage[] = [{ role: "user", content: "hi" }];
    const noAssistant = makeDb(stored);
    expect(await attachPriorReasoning(userOnly, "chat-1", noAssistant.db)).toBe(
      userOnly,
    );
    expect(noAssistant.calls.table).toBeUndefined();

    const failing = makeDb(stored, { message: "boom" });
    expect(await attachPriorReasoning(messages, "chat-1", failing.db)).toBe(
      messages,
    );
  });
});

describe("buildMessages reasoning passthrough", () => {
  it("carries reasoning on assistant turns only", () => {
    const formatted = buildMessages(
      [
        { role: "user", content: "q", reasoning: "never sent for users" },
        { role: "assistant", content: "a", reasoning: "why" },
        { role: "assistant", content: "b" },
      ],
      [],
    ) as Record<string, unknown>[];
    expect(formatted.slice(1)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning: "why" },
      { role: "assistant", content: "b" },
    ]);
  });
});
