import { TERMINAL_CODEC } from './terminal-wire';
const bytes = (text: string) => new TextEncoder().encode(text);
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
      "terminal.history",
      "terminal.resize",
      "terminal.detach",
      "terminal.close",
    ]);

    expect(
      parseTerminalRpcParams("terminal.create", {
        executionContextId: "workspace-1",
        cols: 120,
        rows: 32,
      }),
    ).toEqual({ executionContextId: "workspace-1", cols: 120, rows: 32 });
    expect(
      parseTerminalRpcParams("terminal.attach", {
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
        mode: "shared",
        cursor: 14,
      }),
    ).toEqual({
      executionContextId: "workspace-1",
      terminalId: "terminal-1",
      mode: "shared",
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
        snapshot: { codec: TERMINAL_CODEC,
          terminal: {
            terminalId: "terminal-1",
            executionContextId: "workspace-1",
            title: "zsh",
            status: "running",
            cols: 80,
            rows: 24,
          },
          generation: "generation-1",
          cursor: 7,
          retainedFrom: 3,
          data: bytes("$ echo ready\r\nready\r\n"),
          },
      }),
    ).toEqual({
      attachment: {
        attachmentId: "attachment-1",
        mode: "observe",
      },
      snapshot: { codec: TERMINAL_CODEC,
        terminal: {
          terminalId: "terminal-1",
          executionContextId: "workspace-1",
          title: "zsh",
          status: "running",
          cols: 80,
          rows: 24,
        },
        generation: "generation-1",
        cursor: 7,
        retainedFrom: 3,
        data: bytes("$ echo ready\r\nready\r\n"),
      },
    });
  });

  test("rejects invalid dimensions, attachment modes, cursors, and input", () => {
    expect(() =>
      parseTerminalRpcParams("terminal.create", {
        executionContextId: "workspace-1",
        cols: 1,
        rows: 24,
      }),
    ).toThrow("cols");
    expect(() =>
      parseTerminalRpcParams("terminal.resize", {
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        cols: 80,
        rows: 10_000,
      }),
    ).toThrow("rows");
    expect(() =>
      parseTerminalRpcParams("terminal.attach", {
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
        mode: "write",
      }),
    ).toThrow("mode");
    expect(() =>
      parseTerminalRpcParams("terminal.attach", {
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
        mode: "observe",
        cursor: -1,
      }),
    ).toThrow("cursor");
    expect(() =>
      parseTerminalRpcParams("terminal.input", {
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        data: bytes(""),
      }),
    ).toThrow("data");
  });

  for (const data of ["\r", " ", "\t"]) {
    test(`accepts raw whitespace and control input ${JSON.stringify(data)}`, () => {
      expect(
        parseTerminalRpcParams("terminal.input", {
          executionContextId: "workspace-1",
          terminalId: "terminal-1",
          attachmentId: "attachment-1",
          data: bytes(data),
        }),
      ).toEqual({
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
        attachmentId: "attachment-1",
        data: bytes(data),
      });
    });
  }

  test("parses sequenced output, title, exit, and resync notifications", () => {
    expect(
      parseTerminalNotification(TERMINAL_EVENT_METHOD, {
        attachmentId: "attachment-1",
        terminalId: "terminal-1",
        executionContextId: "workspace-1",
        generation: "generation-1",
        sequence: 8,
        event: { type: "output", data: bytes("ready\r\n") },
      }).event,
    ).toEqual({ type: "output", data: bytes("ready\r\n") });

    for (const data of ["\r\n", " ", "\t"]) {
      expect(
        parseTerminalNotification(TERMINAL_EVENT_METHOD, {
          attachmentId: "attachment-1",
          terminalId: "terminal-1",
          executionContextId: "workspace-1",
          generation: "generation-1",
          sequence: 9,
          event: { type: "output", data: bytes(data) },
        }).event,
      ).toEqual({ type: "output", data: bytes(data) });
    }

    for (const event of [
      { type: "title", title: "vim" },
      { type: "exit", exitCode: 0 },
      { type: "resync", retainedFrom: 12 },
    ]) {
      expect(
        parseTerminalNotification(TERMINAL_EVENT_METHOD, {
          attachmentId: "attachment-1",
          terminalId: "terminal-1",
          executionContextId: "workspace-1",
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
        code: "TERMINAL_WRITE_REQUIRED",
        executionContextId: "workspace-1",
        terminalId: "terminal-1",
      }),
    ).toEqual({
      domain: "terminal",
      code: "TERMINAL_WRITE_REQUIRED",
      executionContextId: "workspace-1",
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


test('screen replacements validate the authoritative grid and payload', () => {
  const notification = { attachmentId: 'a', terminalId: 't', executionContextId: 'e', generation: 'g', sequence: 1,
    event: { type: 'screen', terminal: { terminalId: 't', executionContextId: 'e', title: 'shell', status: 'running', cols: 150, rows: 50 }, data: bytes('screen') } };
  expect(parseTerminalNotification(TERMINAL_EVENT_METHOD, notification)).toEqual(notification);
  expect(() => parseTerminalNotification(TERMINAL_EVENT_METHOD, { ...notification, event: { ...notification.event, terminal: { ...notification.event.terminal, cols: 0 } } })).toThrow('cols');
  expect(() => parseTerminalNotification(TERMINAL_EVENT_METHOD, { ...notification, event: { ...notification.event, data: 1 } })).toThrow('data');
});
