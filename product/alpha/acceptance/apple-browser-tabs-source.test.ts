import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const alphaRoot = resolve(import.meta.dir, '..');
const hosts = [
  resolve(alphaRoot, 'ios/App/App/AlphaBrowserHost.swift'),
  resolve(alphaRoot, 'macos/Sources/WeaveAlpha/WeaveAlpha.swift'),
];

describe.each(hosts)('human Browser tabs in %s', (host) => {
  const source = readFileSync(host, 'utf8');

  it('owns ordered WebViews in one ephemeral process profile', () => {
    expect(source).toContain('browserDataStore = WKWebsiteDataStore.nonPersistent()');
    expect(source).toContain('browserTabs: [AlphaBrowserTab]');
    expect(source).toContain('configuration.websiteDataStore = browserDataStore');
    expect(source).toContain('recentBrowserTabIds');
    expect(source).toContain('createBrowserTab(after: selectedBrowserTabId, select: true)');
  });

  it('implements the full human tab command and lifecycle boundary', () => {
    for (const command of ['tab.new', 'tab.select', 'tab.close', 'open.external']) {
      expect(source).toContain(`case "${command}"`);
    }
    expect(source).toContain('if browserTabs.isEmpty');
    expect(source).toContain('browserTabs.removeAll()');
    expect(source).toContain('if browserResetInProgress');
    expect(source).toContain('tab.webView.isHidden = !browserPresentationRequested');
    expect(source).toContain('tab.id != selectedBrowserTabId || tab.webView.url == nil');
  });

  it('reports new-window tabs and blank start state to React', () => {
    expect(source).toContain('"popups": "new-tab"');
    expect(source).toContain('"url": tab.webView.url?.absoluteString ?? ""');
    expect(source).toContain('configuration: configuration');
    expect(source).toContain('return popup');
    expect(source).toContain("weave:alpha-browser-open-external");
    expect(source).toContain('dispatchHumanShortcut(input)');
    expect(source).toContain('navigationAction.targetFrame?.isMainFrame');
  });

  it('keeps SPA chrome state current and clears transient notices on navigation', () => {
    expect(source).toContain('stateObservations: [NSKeyValueObservation]');
    for (const keyPath of ['title', 'url', 'canGoBack', 'canGoForward', 'isLoading']) {
      expect(source).toContain(`tab.webView.observe(\\.${keyPath}`);
    }
    expect(source).toContain('didStartProvisionalNavigation');
    expect(source).toContain('tab.notice = nil');
  });
});
