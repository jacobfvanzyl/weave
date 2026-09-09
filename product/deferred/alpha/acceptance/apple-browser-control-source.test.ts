import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const alphaRoot = resolve(import.meta.dir, '..');
const shared = resolve(alphaRoot, 'apple/AlphaBrowserControl.swift');
const macos = resolve(alphaRoot, 'macos/Sources/WeaveAlpha/AlphaBrowserControl.swift');
const ipad = resolve(alphaRoot, 'ios/App/App/AlphaBrowserControl.swift');

describe('shared Apple visible-browser control host', () => {
  it('is one implementation compiled by both signed Apple hosts', () => {
    expect(lstatSync(macos).isSymbolicLink()).toBe(true);
    expect(lstatSync(ipad).isSymbolicLink()).toBe(true);
    expect(resolve(macos, '..', readlinkSync(macos))).toBe(shared);
    expect(resolve(ipad, '..', readlinkSync(ipad))).toBe(shared);
  });

  it('keeps projection, policy, cancellation, and typed failures in the shared engine', () => {
    const source = readFileSync(shared, 'utf8');
    expect(source).toContain('final class AlphaBrowserControlEngine');
    expect(source).toContain('input:not([type="password"]):not([type="file"])');
    expect(source).toContain('func cancel(requestId: String)');
    expect(source).toContain('"STALE_VIEW"');
    expect(source).toContain('"INVALID_TARGET"');
    expect(source).toContain('"TIMEOUT"');
    expect(source).toContain('"CANCELLED"');
    expect(source).not.toContain('document.cookie');
    expect(source).not.toContain('localStorage');
  });

  it('parses the fractional-second RFC 3339 deadlines emitted by Portal', () => {
    const source = readFileSync(shared, 'utf8');
    expect(source).toContain('func deadline(from value: Any?)');
    expect(source).toContain('.withFractionalSeconds');
    expect(source).toContain('deadline(from: request["deadlineAt"])');
  });

  it('forwards trusted hardware-keyboard Browser shortcuts out of native page content', () => {
    const source = readFileSync(shared, 'utf8');
    expect(source).toContain('let alphaBrowserHumanInputSource');
    expect(source).toContain("kind: shortcut ? 'shortcut' : 'input'");
    expect(source).toContain('metaKey: event.metaKey');
    expect(source).toContain('if (shortcut && command) event.preventDefault()');
  });
});
