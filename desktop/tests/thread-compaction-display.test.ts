import { describe, expect, it } from "vitest";
import {
  getThreadCompactionDisplay,
  getThreadCompactionDisplayLabel,
  getThreadCompactionPartDisplay,
  isThreadCompactionFallbackText,
} from "../../packages/client/src/lib/thread-compaction-display";

describe("thread compaction display", () => {
  it("labels automatic and manual checkpoints", () => {
    expect(getThreadCompactionDisplayLabel("automatic")).toBe(
      "Context automatically compacted",
    );
    expect(getThreadCompactionDisplayLabel("manual")).toBe(
      "Context manually compacted",
    );
  });

  it("reads persisted compaction marker metadata", () => {
    expect(getThreadCompactionDisplay({
      weaveDisplay: {
        kind: "thread_compaction",
        trigger: "automatic",
        generation: 2,
      },
    })).toEqual({ trigger: "automatic", generation: 2 });
  });

  it("reads the persisted data part after adjacent assistant messages are merged", () => {
    const part = {
      type: "data-thread-compaction",
      data: {
        phase: "completed",
        trigger: "manual",
        generation: 3,
      },
    };

    expect(getThreadCompactionPartDisplay(part)).toEqual({
      trigger: "manual",
      generation: 3,
    });
    expect(isThreadCompactionFallbackText("Context manually compacted", part))
      .toBe(true);
    expect(isThreadCompactionFallbackText("Actual assistant response", part))
      .toBe(false);
    expect(getThreadCompactionPartDisplay({
      type: "data",
      name: "thread-compaction",
      data: part.data,
    })).toEqual({ trigger: "manual", generation: 3 });
  });

  it("ignores non-completed compaction data parts", () => {
    expect(getThreadCompactionPartDisplay({
      type: "data-thread-compaction",
      data: { phase: "started", trigger: "automatic" },
    })).toBeUndefined();
  });

  it("ignores malformed or unrelated display metadata", () => {
    expect(
      getThreadCompactionDisplay({
        weaveDisplay: { kind: "thread_compaction" },
      }),
    ).toBeUndefined();
    expect(getThreadCompactionDisplay({ weaveDisplay: { kind: "proposal" } }))
      .toBeUndefined();
  });
});
