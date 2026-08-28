import { describe, expect, test } from "bun:test";
import {
  parseTerminalErrorData,
  parseTerminalNotification,
  parseTerminalRpcParams,
  parseTerminalRpcResult,
  TERMINAL_EVENT_METHOD,
  TERMINAL_RPC_METHODS,
} from "./terminals";

describe("Terminal protocol", () => {
  test("exposes the complete persistent Terminal lifecycle", () => {
    expect(TERMINAL_RPC_METHODS).toEqual([
      "terminal.list",
      "terminal.create",
      "terminal.snapshot",
      "terminal.attach",
      "terminal.input",
      "terminal.resize",
      "terminal.detach",
      "terminal.close",
    ]);

    expect(
      parseTerminalRpcParams("terminal.create", {
        workspaceId: "workspace-1",
        cols: 120,
        rows: 32,
      }),
    ).toEqual({ workspaceId: "workspace-1", cols: 120, rows: 32 });
    expect(
      parseTerminalRpcParams("terminal.attach", {
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        mode: "control",
        cursor: 14,
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      terminalId: "terminal-1",
      mode: "control",
      cursor: 14,
    });
  });

  test("parses a coherent snapshot and attachment response", () => {
    expect(
      parseTerminalRpcResult("terminal.attach", {
        attachment: {
          attachmentId: "attachment-1",
          mode: "observe",
        },
        snapshot: {
          terminal: {
            terminalId: "terminal-1",
            workspaceId: "workspace-1",
            title: "zsh",
            status: "running",
            cols: 80,
            rows: 24,
          },
          generation: "generation-1",
          cursor: 7,
          retainedFrom: 3,
          data: "$ echo ready\r\nready\r\n",
          controller: { controlled: true, attachmentId: "attachment-2" },
        },
      }),
    ).toEqual({
      attachment: {
        attachmentId: "attachment-1",
        mode: "observe",
      },
      snapshot: {
        terminal: {
          terminalId: "terminal-1",
          workspaceId: "workspace-1",
          title: "zsh",
          status: "running",
          cols: 80,
          rows: 24,
        },
        generation: "generation-1",
        cursor: 7,
        retainedFrom: 3,
        data: "$ echo ready\r\nready\r\n",
        controller: { controlled: true, attachmentId: "attachment-2" },
      },
    });
  });

  test("rejects invalid dimensions, attachment modes, cursors, and input", () => {
    expect(() =>
      parseTerminalRpcParams("terminal.create", {
        workspaceId: "workspace-1",
        cols: 1,
        rows: 24,
      }),
    ).toThrow("cols");
    expect(() =>
      parseTerminalRpcParams("terminal.resize", {
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        cols: 80,
        rows: 10_000,
      }),
    ).toThrow("rows");
    expect(() =>
      parseTerminalRpcParams("terminal.attach", {
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        mode: "write",
      }),
    ).toThrow("mode");
    expect(() =>
      parseTerminalRpcParams("terminal.attach", {
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        mode: "observe",
        cursor: -1,
      }),
    ).toThrow("cursor");
    expect(() =>
      parseTerminalRpcParams("terminal.input", {
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        data: "",
      }),
    ).toThrow("data");
  });

  for (const data of ["\r", " ", "\t"]) {
    test(`accepts raw whitespace and control input ${JSON.stringify(data)}`, () => {
      expect(
        parseTerminalRpcParams("terminal.input", {
          workspaceId: "workspace-1",
          terminalId: "terminal-1",
          attachmentId: "attachment-1",
          data,
        }),
      ).toEqual({
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        data,
      });
    });
  }

  test("parses sequenced output, control, title, exit, and resync notifications", () => {
    expect(
      parseTerminalNotification(TERMINAL_EVENT_METHOD, {
        attachmentId: "attachment-1",
        terminalId: "terminal-1",
        workspaceId: "workspace-1",
        generation: "generation-1",
        sequence: 8,
        event: { type: "output", data: "ready\r\n" },
      }).event,
    ).toEqual({ type: "output", data: "ready\r\n" });

    for (const data of ["\r\n", " ", "\t"]) {
      expect(
        parseTerminalNotification(TERMINAL_EVENT_METHOD, {
          attachmentId: "attachment-1",
          terminalId: "terminal-1",
          workspaceId: "workspace-1",
          generation: "generation-1",
          sequence: 9,
          event: { type: "output", data },
        }).event,
      ).toEqual({ type: "output", data });
    }

    for (const event of [
      { type: "title", title: "vim" },
      { type: "control", controlled: false },
      { type: "exit", exitCode: 0 },
      { type: "resync", retainedFrom: 12 },
    ]) {
      expect(
        parseTerminalNotification(TERMINAL_EVENT_METHOD, {
          attachmentId: "attachment-1",
          terminalId: "terminal-1",
          workspaceId: "workspace-1",
          generation: "generation-1",
          sequence: 9,
          event,
        }).event,
      ).toEqual(event);
    }
  });

  test("parses typed control, retention, and resource errors", () => {
    expect(
      parseTerminalErrorData({
        domain: "terminal",
        code: "TERMINAL_CONTROLLED",
        workspaceId: "workspace-1",
        terminalId: "terminal-1",
      }),
    ).toEqual({
      domain: "terminal",
      code: "TERMINAL_CONTROLLED",
      workspaceId: "workspace-1",
      terminalId: "terminal-1",
    });
    expect(() =>
      parseTerminalErrorData({
        domain: "terminal",
        code: "UNKNOWN",
      }),
    ).toThrow("code");
  });
});
