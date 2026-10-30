import { describe, expect, test } from "vitest";
import { ServerFrameSchema, decodeServerFrame, isUnknownFrame } from "../src";

describe("server frame types", () => {
  test("every frame type in the protocol schema is known to the client", () => {
    for (const option of ServerFrameSchema.options) {
      const type = option.shape.type.value as string;
      const result = decodeServerFrame(JSON.stringify({ type, seq: 1 }));
      // A known type either decodes or fails on its payload; it is never "unknown".
      expect(result.ok && isUnknownFrame(result.frame), type).toBe(false);
    }
  });

  test("task frames the web client used to drop are known", () => {
    for (const type of ["task.create.ok", "task.list.create.ok", "task.activity.ok"]) {
      const result = decodeServerFrame(JSON.stringify({ type, seq: 1 }));
      expect(result.ok && isUnknownFrame(result.frame), type).toBe(false);
    }
  });

  test("a type the schema does not know still passes through as unknown", () => {
    const result = decodeServerFrame(JSON.stringify({ type: "not.a.real.frame", seq: 4 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(isUnknownFrame(result.frame)).toBe(true);
  });
});
