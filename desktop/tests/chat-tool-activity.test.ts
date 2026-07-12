import { describe, expect, it } from "vitest";
import {
  getAssistantContentRanges,
  getAutoCollapsedAssistantTextPartIndices,
  getDefaultAutoCollapsedAssistantTurnIds,
} from "../../packages/client/src/components/chat/assistant-content-ranges";
import {
  buildProposalImplementationMessage,
  buildProposalImplementationUserMessage,
  getProposalActionDisplay,
  getProposalActionDisplayLabel,
} from "../../packages/client/src/components/chat/proposal-implementation";
import {
  getToolActivityFollowTarget,
  getToolActivitySideEffect,
  getToolChipDetail,
  getToolResultText,
  isHiddenToolCall,
  isProposalTool,
  shouldRenderToolActivityChildren,
  summarizeToolActivity,
  toToolActivityCall,
} from "../../packages/client/src/components/chat/tool-activity";
import {
  buildAskUserResponseMetadata,
  buildAskUserResponseText,
  parseAskUserPart,
  parseAskUserResponseMetadata,
} from "../../packages/client/src/components/chat/ask-user";
import {
  formatWorkDuration,
  getWorkedForLabel,
  getWorkingForLabel,
  withAssistantRunTimingCustomMetadata,
} from "../../packages/client/src/components/chat/turn-timing";

describe("chat tool activity helpers", () => {
  it("formats live and completed turn timing labels", () => {
    expect(formatWorkDuration(19_900)).toBe("19s");
    expect(formatWorkDuration(65_000)).toBe("1m05s");
    expect(formatWorkDuration(3_665_000)).toBe("1h01m");

    expect(
      getWorkingForLabel(
        "2026-07-02T10:00:00.000Z",
        Date.parse("2026-07-02T10:00:19.000Z"),
      ),
    ).toBe("Working for 19s");
    expect(
      getWorkingForLabel(undefined, Date.parse("2026-07-02T10:00:19.000Z")),
    ).toBe("Working...");
    expect(getWorkedForLabel({
      weaveRunTiming: {
        runId: "run-1",
        status: "completed",
        startedAt: "2026-07-02T10:00:00.000Z",
        completedAt: "2026-07-02T10:00:19.000Z",
      },
    })).toBe("Worked for 19s");
    expect(getWorkedForLabel({
      weaveRunTiming: {
        runId: "run-1",
        status: "running",
        startedAt: "2026-07-02T10:00:00.000Z",
      },
    })).toBeNull();
    expect(
      getWorkedForLabel({ custom: { weaveRunTiming: { durationMs: 19_000 } } }),
    ).toBe("Worked for 19s");
    expect(
      getWorkedForLabel({ custom: { weaveRunTiming: { durationMs: 65_000 } } }),
    ).toBe("Worked for 1m05s");
    expect(
      getWorkedForLabel({ custom: { weaveRunTiming: { durationMs: 3_665_000 } } }),
    ).toBe("Worked for 1h01m");
    expect(getWorkedForLabel({})).toBeNull();
  });

  it("promotes legacy root timing metadata into assistant-ui custom metadata", () => {
    const metadata = withAssistantRunTimingCustomMetadata({
      weaveRunTiming: { status: "completed", durationMs: 65_000 },
      source: "persisted",
    });

    expect(metadata).toEqual({
      weaveRunTiming: { status: "completed", durationMs: 65_000 },
      source: "persisted",
      custom: {
        weaveRunTiming: { status: "completed", durationMs: 65_000 },
      },
    });
    expect(getWorkedForLabel(metadata)).toBe("Worked for 1m05s");
  });

  it("builds scoped proposal implementation instructions", () => {
    const message = buildProposalImplementationMessage({
      proposalPath: ".agents/proposals/demo.md",
      approvedItemIds: ["item-1", "item-2"],
    });

    expect(message).toContain(
      "Implement the approved proposal items from .agents/proposals/demo.md.",
    );
    expect(message).toContain("Approved item ids: item-1, item-2");
    expect(message).toContain("Implement only approved items.");
    expect(message).toContain(
      "Do not implement pending, rejected, stale, or changes-requested items.",
    );
    expect(message).toContain(
      "use proposal_mark for applied/stale/changes_requested outcomes",
    );
  });

  it("builds compact display metadata for proposal implementation messages", () => {
    const message = buildProposalImplementationUserMessage({
      id: "request-1",
      proposalPath: ".agents/proposals/demo.md",
      approvedItemIds: ["item-1", "item-2"],
      requestedAt: "2026-06-29T10:00:00.000Z",
    });

    expect(message.text).toContain(
      "Implement the approved proposal items from .agents/proposals/demo.md.",
    );
    expect(message.metadata).toMatchObject({
      proposalImplementation: {
        proposalPath: ".agents/proposals/demo.md",
        approvedItemIds: ["item-1", "item-2"],
        mode: "implement",
        requestedAt: "2026-06-29T10:00:00.000Z",
      },
      weaveDisplay: {
        kind: "proposal_implementation_request",
        proposalPath: ".agents/proposals/demo.md",
      },
    });
    expect(getProposalActionDisplay(message.metadata)).toEqual({
      kind: "proposal_implementation_request",
    });
    expect(
      getProposalActionDisplayLabel({
        kind: "proposal_implementation_request",
      }),
    ).toBe("Implement proposal");
  });

  it("builds compact display metadata for proposal feedback messages", () => {
    const message = buildProposalImplementationUserMessage({
      id: "request-2",
      proposalPath: ".agents/proposals/demo.md",
      approvedItemIds: [],
      mode: "address_feedback",
      requestedAt: "2026-06-29T10:05:00.000Z",
    });

    expect(message.text).toContain(
      "Address review feedback for the proposal at .agents/proposals/demo.md.",
    );
    expect(message.metadata).toMatchObject({
      proposalImplementation: {
        proposalPath: ".agents/proposals/demo.md",
        approvedItemIds: [],
        mode: "address_feedback",
        requestedAt: "2026-06-29T10:05:00.000Z",
      },
      weaveDisplay: {
        kind: "proposal_review_feedback",
        proposalPath: ".agents/proposals/demo.md",
      },
    });
    expect(getProposalActionDisplay(message.metadata)).toEqual({
      kind: "proposal_review_feedback",
    });
    expect(getProposalActionDisplayLabel({ kind: "proposal_review_feedback" }))
      .toBe("Revise proposal");
  });

  it("classifies legacy proposal implementation metadata for compact rendering", () => {
    expect(getProposalActionDisplay({
      proposalImplementation: {
        proposalPath: ".agents/proposals/demo.md",
        mode: "address_feedback",
      },
    })).toEqual({ kind: "proposal_review_feedback" });

    expect(getProposalActionDisplay({
      proposalImplementation: {
        proposalPath: ".agents/proposals/demo.md",
        mode: "implement",
      },
    })).toEqual({ kind: "proposal_implementation_request" });
  });

  it("classifies nested assistant-ui custom metadata for compact rendering", () => {
    expect(getProposalActionDisplay({
      custom: {
        weaveDisplay: {
          kind: "proposal_review_feedback",
        },
      },
    })).toEqual({ kind: "proposal_review_feedback" });

    expect(getProposalActionDisplay({
      custom: {
        proposalImplementation: {
          proposalPath: ".agents/proposals/demo.md",
          mode: "implement",
        },
      },
    })).toEqual({ kind: "proposal_implementation_request" });
  });

  it("classifies persisted proposal action messages without metadata from text", () => {
    expect(getProposalActionDisplay(
      undefined,
      [
        "Address review feedback for the proposal at .agents/proposals/demo.md.",
        "",
        "Before editing anything, read the proposal artifact and its review comments.",
      ].join("\n"),
    )).toEqual({ kind: "proposal_review_feedback" });

    expect(getProposalActionDisplay(
      null,
      [
        "Implement the approved proposal items from .agents/proposals/demo.md.",
        "",
        "Approved item ids: item-1, item-2",
      ].join("\n"),
    )).toEqual({ kind: "proposal_implementation_request" });
  });

  it("does not split tool activity groups on hidden reasoning parts", () => {
    const parts = [
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "a.ts" },
        result: "ok",
      },
      { type: "reasoning", text: "I should inspect another file." },
      {
        type: "tool-call",
        toolCallId: "read-2",
        toolName: "read",
        args: { path: "b.ts" },
        result: "ok",
      },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "tool-activity", indices: [0, 2] },
    ]);

    expect(getAssistantContentRanges(parts, true)).toEqual([
      { type: "tool-activity", indices: [0] },
      { type: "reasoning", indices: [1] },
      { type: "tool-activity", indices: [2] },
    ]);
  });

  it("keeps steered user message data as a visible assistant content boundary", () => {
    const parts = [
      { type: "text", text: "First assistant segment." },
      {
        type: "data",
        name: "user-message",
        data: { id: "steer-1", contents: "Use the same IoT checks." },
      },
      { type: "text", text: "Second assistant segment." },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "part", index: 0 },
      { type: "part", index: 1 },
      { type: "part", index: 2 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([]);
  });

  it("keeps completed thread compaction data as a visible assistant content boundary", () => {
    const parts = [
      { type: "text", text: "Acknowledged generation-two-1." },
      { type: "text", text: "Context manually compacted" },
      {
        type: "data",
        name: "thread-compaction",
        data: { phase: "completed", trigger: "manual", generation: 2 },
      },
      { type: "text", text: "Next assistant segment." },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "part", index: 0 },
      { type: "part", index: 1 },
      { type: "part", index: 2 },
      { type: "part", index: 3 },
    ]);
  });

  it("keeps submitted ask_user data as a visible assistant content boundary", () => {
    const askPart = {
      type: "data-ask-user",
      data: {
        mastraRunId: "mastra-run-1",
        toolCallId: "ask-1",
        status: "submitted",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How broad should this be?",
            options: [
              {
                id: "narrow",
                label: "Narrow",
                description: "Only the current path.",
              },
              {
                id: "broad",
                label: "Broad",
                description: "Include adjacent surfaces.",
              },
            ],
          },
        ],
      },
    };
    const parts = [
      { type: "text", text: "I need one decision." },
      askPart,
      { type: "text", text: "I will continue after that." },
    ];

    expect(parseAskUserPart(askPart)).toMatchObject({
      mastraRunId: "mastra-run-1",
      toolCallId: "ask-1",
      status: "submitted",
      questions: [{
        id: "scope",
        options: [{ id: "narrow" }, { id: "broad" }],
      }],
    });
    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "part", index: 0 },
      { type: "part", index: 1 },
      { type: "part", index: 2 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([2]);
  });

  it("hides pending ask_user data from inline assistant content ranges", () => {
    const askPart = {
      type: "data-ask-user",
      data: {
        mastraRunId: "mastra-run-1",
        toolCallId: "ask-1",
        status: "pending",
        questions: [
          {
            id: "scope",
            question: "How broad should this be?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "broad", label: "Broad" },
            ],
          },
        ],
      },
    };

    expect(parseAskUserPart(askPart)).toMatchObject({
      mastraRunId: "mastra-run-1",
      toolCallId: "ask-1",
      status: "pending",
      questions: [{ id: "scope" }],
    });
    expect(getAssistantContentRanges([askPart], false)).toEqual([]);
    expect(getAutoCollapsedAssistantTextPartIndices([askPart], false)).toEqual(
      [],
    );
  });

  it("parses assistant-ui normalized ask_user data parts", () => {
    const askPart = {
      type: "data",
      name: "ask-user",
      data: {
        mastraRunId: "mastra-run-1",
        toolCallId: "ask-1",
        status: "pending",
        questions: [
          {
            id: "scope",
            question: "How broad should this be?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "broad", label: "Broad" },
            ],
          },
        ],
      },
    };

    expect(parseAskUserPart(askPart)).toMatchObject({
      mastraRunId: "mastra-run-1",
      toolCallId: "ask-1",
      status: "pending",
      questions: [{
        id: "scope",
        options: [{ id: "narrow" }, { id: "broad" }],
      }],
    });
    expect(getAssistantContentRanges([askPart], false)).toEqual([]);
  });

  it("parses raw ask_user suspension envelopes from Mastra streams", () => {
    const rawSuspension = {
      type: "data-tool-call-suspended",
      runId: "mastra-run-1",
      toolCallId: "ask-1",
      toolName: "ask_user",
      suspendPayload: {
        questions: [
          {
            id: "scope",
            question: "How broad should this be?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "broad", label: "Broad" },
            ],
          },
        ],
      },
    };

    expect(parseAskUserPart(rawSuspension)).toMatchObject({
      mastraRunId: "mastra-run-1",
      toolCallId: "ask-1",
      status: "pending",
      questions: [{ id: "scope" }],
    });
    expect(parseAskUserPart({
      type: "data",
      name: "tool-call-suspended",
      data: rawSuspension,
    })).toMatchObject({
      mastraRunId: "mastra-run-1",
      toolCallId: "ask-1",
      questions: [{ id: "scope" }],
    });
  });

  it("builds ask_user response text and metadata for resume submissions", () => {
    const part = parseAskUserPart({
      type: "data-ask-user",
      data: {
        mastraRunId: "mastra-run-1",
        toolCallId: "ask-1",
        status: "pending",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How broad should this be?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "broad", label: "Broad" },
            ],
          },
        ],
      },
    });
    if (!part) throw new Error("expected ask_user part to parse");
    const resume = {
      action: "submit" as const,
      answers: [{
        id: "scope",
        selectedOptionId: "narrow",
        finalAnswer: "Narrow",
      }],
    };

    expect(buildAskUserResponseText(part!, resume)).toBe("Scope: Narrow");
    const metadata = buildAskUserResponseMetadata(part!, resume);
    expect(metadata).toMatchObject({
      custom: {
        askUserResponse: {
          toolCallId: "ask-1",
          mastraRunId: "mastra-run-1",
          questions: [{ id: "scope", header: "Scope" }],
          action: "submit",
          answers: [{
            id: "scope",
            selectedOptionId: "narrow",
            finalAnswer: "Narrow",
          }],
        },
        weaveDisplay: {
          kind: "ask_user_response",
          toolCallId: "ask-1",
        },
      },
    });
    expect(parseAskUserResponseMetadata(metadata)).toMatchObject({
      toolCallId: "ask-1",
      mastraRunId: "mastra-run-1",
      questions: [{ id: "scope", header: "Scope" }],
      resume: {
        action: "submit",
        answers: [{
          id: "scope",
          selectedOptionId: "narrow",
          finalAnswer: "Narrow",
        }],
      },
    });
    expect(parseAskUserResponseMetadata(metadata.custom)).toMatchObject({
      toolCallId: "ask-1",
      mastraRunId: "mastra-run-1",
      resume: {
        action: "submit",
        answers: [{
          id: "scope",
          selectedOptionId: "narrow",
          finalAnswer: "Narrow",
        }],
      },
    });

    const cancelMetadata = buildAskUserResponseMetadata(part!, {
      action: "cancel",
      reason: "cancelled_by_user",
    });
    expect(cancelMetadata).toMatchObject({
      custom: {
        askUserResponse: {
          toolCallId: "ask-1",
          mastraRunId: "mastra-run-1",
          action: "cancel",
          reason: "cancelled_by_user",
        },
      },
    });
    expect(parseAskUserResponseMetadata(cancelMetadata)).toMatchObject({
      toolCallId: "ask-1",
      mastraRunId: "mastra-run-1",
      resume: {
        action: "cancel",
        reason: "cancelled_by_user",
      },
    });
  });

  it("hides leaked proposal function-call text while preserving adjacent assistant text", () => {
    const parts = [
      { type: "text", text: "I am updating the draft proposal." },
      {
        type: "text",
        text:
          'functions.proposal_status({"proposalPath":".agents/proposals/demo.md"})',
      },
      {
        type: "tool-functions.proposal_status",
        toolCallId: "proposal-1",
        input: {},
        output: { items: [] },
        state: "output-available",
      },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "part", index: 0 },
      { type: "tool-activity", indices: [2] },
    ]);
  });

  it("hides leaked compact git diff output while preserving ordinary result prose", () => {
    const parts = [
      { type: "text", text: "I checked the current diff." },
      {
        type: "text",
        text: [
          "git_diff result:",
          "git_diff ok: true contentChars: 519 contentHash: 8e76b34ccec3",
          "",
          "diff --git a/lib/entities/enums.dart b/lib/entities/enums.dart",
          "@@ -80,6 +80,10 @@ enum Entity {",
          "+  spreaderInstruction(",
          "+    label: 'Spreader Instruction',",
        ].join("\n"),
      },
      {
        type: "text",
        text: "git_diff result:\nThis phrase is part of a normal explanation.",
      },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "part", index: 0 },
      { type: "part", index: 2 },
    ]);
  });

  it("selects only trailing final text when an assistant turn has earlier visible work", () => {
    const parts = [
      { type: "reasoning", text: "I should inspect the repo." },
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "a.ts" },
        result: "ok",
      },
      { type: "text", text: "The fix is implemented." },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "tool-activity", indices: [1] },
      { type: "part", index: 2 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, true)).toEqual([2]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([2]);
  });

  it("keeps completed persisted dynamic tool summaries visible before final text", () => {
    const parts = [
      {
        type: "tool-read",
        toolCallId: "read-1",
        input: { path: "a.ts" },
        output: "ok",
        state: "output-available",
      },
      { type: "text", text: "The fix is implemented." },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "tool-activity", indices: [0] },
      { type: "part", index: 1 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([1]);
  });

  it("keeps multiple completed tool/text cycles represented as visible ranges", () => {
    const parts = [
      { type: "text", text: "I will inspect the repo." },
      {
        type: "tool-bash",
        toolCallId: "call-1",
        input: { command: "rg needle src" },
        output: "ok",
        state: "output-available",
      },
      { type: "text", text: "I found the path and will check one file." },
      {
        type: "tool-read",
        toolCallId: "read-1",
        input: { path: "src/example.ts" },
        output: "ok",
        state: "output-available",
      },
      { type: "text", text: "Done." },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: "part", index: 0 },
      { type: "tool-activity", indices: [1] },
      { type: "part", index: 2 },
      { type: "tool-activity", indices: [3] },
      { type: "part", index: 4 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([4]);
  });

  it("derives default auto-collapsed turns only from timed completed assistant messages", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        status: { type: "complete" },
        metadata: { weaveRunTiming: { status: "completed", durationMs: 19_000 } },
        parts: [
          {
            type: "tool-bash",
            toolCallId: "call-1",
            input: { command: "npm test" },
            output: "ok",
            state: "output-available",
          },
          { type: "text", text: "Done." },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        status: { type: "complete" },
        parts: [{ type: "text", text: "Plain answer." }],
      },
      {
        id: "assistant-3",
        role: "assistant",
        status: { type: "running" },
        metadata: { weaveRunTiming: { status: "running", startedAt: "2026-07-02T10:00:00.000Z" } },
        parts: [
          {
            type: "tool-bash",
            toolCallId: "call-2",
            input: { command: "npm test" },
            output: "ok",
            state: "output-available",
          },
          { type: "text", text: "Still running." },
        ],
      },
    ];

    expect(getDefaultAutoCollapsedAssistantTurnIds(messages, false)).toEqual({
      "assistant-1": true,
    });
    expect(
      getDefaultAutoCollapsedAssistantTurnIds(messages, false, {
        "assistant-1": true,
      }),
    ).toEqual({});
  });

  it("keeps eligible completed turns expanded when timing metadata is missing", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      status: { type: "complete" },
      parts: [
        {
          type: "tool-read",
          toolCallId: "read-1",
          input: { path: "a.ts" },
          output: "ok",
          state: "output-available",
        },
        { type: "text", text: "Done." },
      ],
    };

    expect(getAutoCollapsedAssistantTextPartIndices(message.parts, false)).toEqual([1]);
    expect(getDefaultAutoCollapsedAssistantTurnIds([message], false)).toEqual({});
  });

  it("does not auto-collapse plain text-only turns or turns without a final text response", () => {
    expect(getAutoCollapsedAssistantTextPartIndices([
      { type: "text", text: "Just the answer." },
    ], true)).toEqual([]);

    expect(getAutoCollapsedAssistantTextPartIndices([
      { type: "text", text: "I will inspect that." },
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "a.ts" },
        result: "ok",
      },
    ], true)).toEqual([]);
  });

  it("summarizes collapsed tool activity without requiring child detail rendering", () => {
    const call = toToolActivityCall({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: 'rg "needle" packages/client' },
      result: {
        toJSON() {
          throw new Error(
            "result should not be serialized for a collapsed summary",
          );
        },
      },
      status: { type: "complete" },
    });

    expect(call).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      rawStatus: "complete",
    });
    expect(summarizeToolActivity([call!])).toBe("Explored 1 search");
    expect(shouldRenderToolActivityChildren(true, 1, true)).toBe(false);
  });

  it("keeps expanded and hidden tool rendering decisions explicit", () => {
    expect(shouldRenderToolActivityChildren(true, 1, false)).toBe(true);
    expect(shouldRenderToolActivityChildren(true, 0, false)).toBe(false);
    expect(shouldRenderToolActivityChildren(false, 1, false)).toBe(false);
  });

  it("summarizes edit results instead of rendering raw diffs", () => {
    expect(getToolResultText("edit", {
      ok: true,
      replacements: 2,
      diff: [
        "@@ -1,100 +1,100 @@",
        "-old value",
        "+new value",
      ].join("\n"),
    })).toBe("Applied 2 replacements.");
  });

  it("uses source file paths for file-scoped proposal tool chips", () => {
    const args = {
      proposalPath: ".agents/proposals/demo.md",
      path: "src/file.ts",
    };

    expect(getToolChipDetail("proposal_edit", args)).toBe("src/file.ts");
    expect(getToolChipDetail("functions.proposal_read", args)).toBe(
      "src/file.ts",
    );
    expect(getToolChipDetail("proposal_status", args)).toBe(
      ".agents/proposals/demo.md",
    );
    expect(getToolChipDetail("proposal_finalize", args)).toBe(
      ".agents/proposals/demo.md",
    );
  });

  it("summarizes file-scoped proposal results with source file paths", () => {
    const args = {
      proposalPath: ".agents/proposals/demo.md",
      path: "src/file.ts",
    };
    const artifactResult = {
      ok: true,
      updated: true,
      path: ".agents/proposals/demo.md",
    };

    expect(getToolResultText("proposal_edit", artifactResult, args)).toBe(
      "Proposal file item updated: src/file.ts",
    );
    expect(
      getToolResultText("proposal_read", {
        ok: true,
        updated: false,
        path: "src/file.ts",
      }, args),
    ).toBe("Proposal file read: src/file.ts");
    expect(
      getToolResultText(
        "proposal_discard",
        { ...artifactResult, discarded: 1 },
        args,
      ),
    ).toBe("Proposal file item discarded: src/file.ts");
    expect(
      getToolResultText(
        "proposal_discard",
        { ...artifactResult, discarded: 0 },
        args,
      ),
    ).toBe("No proposal file item discarded: src/file.ts");
    expect(getToolResultText("proposal_finalize", artifactResult, args)).toBe(
      "Proposal artifact updated: .agents/proposals/demo.md",
    );
  });

  it("keeps rename hidden while rendering artifact plan tool cards", () => {
    expect(
      isHiddenToolCall({
        toolCallId: "rename-1",
        toolName: "renameThreadTool",
      }),
    ).toBe(true);
    expect(isHiddenToolCall({ toolCallId: "ask-1", toolName: "ask_user" }))
      .toBe(true);
    expect(
      isHiddenToolCall({ toolCallId: "write-plan-1", toolName: "write_plan" }),
    ).toBe(false);
    expect(
      isHiddenToolCall({
        toolCallId: "update-plan-1",
        toolName: "update_plan",
      }),
    ).toBe(false);

    expect(getToolActivitySideEffect({
      toolCallId: "rename-1",
      toolName: "renameThreadTool",
      args: { title: "A sharper thread title" },
      rawStatus: "complete",
    })).toEqual({ type: "renameThread", title: "A sharper thread title" });
  });

  it("recognizes only the proposal workspace tools as proposal activity", () => {
    expect(isProposalTool("proposal_start")).toBe(true);
    expect(isProposalTool("proposal_read")).toBe(true);
    expect(isProposalTool("proposal_write")).toBe(true);
    expect(isProposalTool("proposal_edit")).toBe(true);
    expect(isProposalTool("proposal_delete")).toBe(true);
    expect(isProposalTool("proposal_discard")).toBe(true);
    expect(isProposalTool("proposal_status")).toBe(true);
    expect(isProposalTool("proposal_finalize")).toBe(true);
    expect(isProposalTool("proposal_mark")).toBe(true);
    expect(isProposalTool("functions.proposal_status")).toBe(true);
    expect(isProposalTool("apply_proposal")).toBe(false);
    expect(isProposalTool("applyProposalTool")).toBe(false);
    expect(
      toToolActivityCall({
        type: "tool-functions.proposal_status",
        toolCallId: "proposal-1",
        input: { proposalPath: ".agents/proposals/demo.md" },
        output: {
          path: ".agents/proposals/demo.md",
          status: "draft",
          items: [{
            id: "item-1",
            kind: "file_edit",
            status: "pending",
            title: "Update file",
            path: "src/file.ts",
          }],
        },
        state: "output-available",
      })?.toolName,
    ).toBe("proposal_status");
  });

  it("extracts lightweight and legacy artifact plan side effects", () => {
    const effect = getToolActivitySideEffect({
      toolCallId: "plan-1",
      toolName: "update_plan",
      args: {
        title: "Render work",
        artifactPath: "docs/plans/render-work.md",
        plan: [
          { step: "Inspect hot path", status: "completed" },
          { step: "Patch render work", status: "in_progress" },
        ],
      },
      rawStatus: "incomplete",
    });

    expect(effect).toMatchObject({
      type: "updatePlan",
      plan: {
        title: "Render work",
        artifactPath: "docs/plans/render-work.md",
        completed: 1,
        total: 2,
        isBusy: true,
      },
    });

    const artifactEffect = getToolActivitySideEffect({
      toolCallId: "plan-2",
      toolName: "write_plan",
      result: {
        ok: true,
        title: "Plan Artifact Overhaul",
        path: ".agents/plans/bright-river.md",
        status: "blocked",
        checklist: [
          {
            id: "research",
            text: "Research current plan tooling",
            status: "completed",
          },
          {
            id: "implement",
            text: "Implement artifact-aware plan tools",
            status: "blocked",
          },
        ],
        completed: 1,
        total: 2,
        updatedAt: "2026-06-18T12:00:00.000Z",
        contentHash: "abc123",
      },
      rawStatus: "complete",
    });

    expect(artifactEffect).toMatchObject({
      type: "updatePlan",
      plan: {
        title: "Plan Artifact Overhaul",
        artifactPath: ".agents/plans/bright-river.md",
        status: "blocked",
        completed: 1,
        total: 2,
        updatedAt: "2026-06-18T12:00:00.000Z",
        isBusy: false,
        plan: [
          {
            id: "research",
            step: "Research current plan tooling",
            status: "completed",
          },
          {
            id: "implement",
            step: "Implement artifact-aware plan tools",
            status: "blocked",
          },
        ],
      },
    });
  });

  it("extracts follow-write targets from successful write and edit tool calls", () => {
    expect(getToolActivityFollowTarget({
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "src/new.ts" },
      result: { ok: true, bytes: 42 },
    })).toEqual({ path: "src/new.ts", line: 1, toolCallId: "write-1" });

    expect(getToolActivityFollowTarget({
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "src/existing.ts" },
      result: {
        ok: true,
        diff: [
          "--- a/src/existing.ts",
          "+++ b/src/existing.ts",
          "@@ -10,6 +24,8 @@ export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    })).toEqual({ path: "src/existing.ts", line: 24, toolCallId: "edit-1" });
  });

  it("ignores failed or unrelated follow-write calls and falls back for malformed diffs", () => {
    expect(getToolActivityFollowTarget({
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "src/file.ts" },
      result: { ok: true },
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: "write-2",
      toolName: "write",
      args: { path: "src/file.ts" },
      result: { ok: false, error: "nope" },
      isError: true,
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: "write-2b",
      toolName: "write",
      args: { path: "src/file.ts" },
      result: { ok: false, error: "nope" },
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: "write-3",
      toolName: "write",
      args: {},
      result: { ok: true },
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: "edit-2",
      toolName: "edit",
      args: { path: "src/file.ts" },
      result: { ok: true, diff: "not a unified diff" },
    })).toEqual({ path: "src/file.ts", line: 1, toolCallId: "edit-2" });
  });
});
