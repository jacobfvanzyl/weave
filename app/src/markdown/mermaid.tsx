import type { MermaidConfig } from 'mermaid';
import { type DiagramPlugin, type MermaidErrorComponentProps, useIsCodeFenceIncomplete } from 'streamdown';

/**
 * Settings a diagram's own directives and front matter can't change: Mermaid's defaults, plus HTML
 * labels and the theme, so a diagram can neither put HTML in its labels nor CSS in its styles.
 */
const SECURE = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
  'theme',
  'themeVariables',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'darkMode',
];

/**
 * Mermaid's settings: `strict`, labels as SVG text, and the app's palette. Mermaid takes only hex
 * colours, so the theme reads the app's own (the Catppuccin Mocha roles in `styles.css`).
 */
function mermaidConfig(): MermaidConfig {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const background = read('--zed-editor-background', '#1e1e2e');
  const panel = read('--zed-panel-background', '#181825');
  const element = read('--zed-element-hover', '#313244');
  const border = read('--zed-border', '#313244');
  const text = read('--zed-text', '#cdd6f4');
  const muted = read('--zed-icon-muted', '#7f849c');
  const accent = read('--zed-accent', '#cba6f7');
  const fontFamily = read('--font-sans', '"JetBrains Mono Nerd Font", ui-monospace, monospace');
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    theme: 'base',
    darkMode: true,
    fontFamily,
    themeVariables: {
      darkMode: true,
      fontFamily,
      background,
      primaryColor: element,
      primaryTextColor: text,
      primaryBorderColor: accent,
      secondaryColor: panel,
      tertiaryColor: panel,
      lineColor: muted,
      textColor: text,
      mainBkg: element,
      nodeBorder: accent,
      clusterBkg: panel,
      clusterBorder: border,
      titleColor: text,
      edgeLabelBackground: background,
      noteBkgColor: panel,
      noteTextColor: text,
      noteBorderColor: border,
      actorBkg: element,
      actorBorder: accent,
      actorTextColor: text,
      actorLineColor: muted,
      signalColor: muted,
      signalTextColor: text,
      labelBoxBkgColor: element,
      labelBoxBorderColor: accent,
      labelTextColor: text,
      loopTextColor: text,
    },
    secure: SECURE,
  };
}

type Mermaid = typeof import('mermaid').default;

let loading: Promise<Mermaid> | undefined;

/** Mermaid is large, so it loads when the first diagram appears, with the app's settings. */
const loadMermaid = () => {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(mermaidConfig());
    return mermaid;
  });
  return loading;
};

/** A `url(…)` in a style that points anywhere but into the diagram itself. */
const OUTSIDE_URL = /url\(\s*(?!['"]?#)[^)]*\)/i;
const OUTSIDE_URLS = new RegExp(OUTSIDE_URL, 'gi');

/**
 * The diagram Mermaid drew, with nothing in it that runs, fetches or navigates: links unwrapped,
 * HTML (`foreignObject`) and scripts removed, and images and references kept only when they are
 * `data:` images or point within the diagram. Mermaid has already sanitized it; this holds even
 * where its sanitizing lets something through, as `strict` does images in labels.
 */
export function inertSvg(svg: string): string {
  const root = parseSvg(svg);
  if (!root) throw new Error("Mermaid's drawing isn't SVG.");
  for (const element of root.querySelectorAll('script, foreignObject, foreignobject')) element.remove();
  for (const link of root.querySelectorAll('a')) link.replaceWith(...link.childNodes);
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      else if (name === 'href' || name === 'xlink:href' || name === 'src') {
        const inside = value.startsWith('#') || (element.localName === 'image' && value.startsWith('data:image/'));
        if (!inside) {
          if (element.localName === 'image' || element.localName === 'use') element.remove();
          else element.removeAttribute(attribute.name);
        }
      } else if (name === 'style' && OUTSIDE_URL.test(value)) {
        element.setAttribute('style', value.replace(OUTSIDE_URLS, 'none'));
      }
    }
  }
  for (const style of root.querySelectorAll('style')) style.textContent = (style.textContent ?? '').replace(OUTSIDE_URLS, 'none');
  return new XMLSerializer().serializeToString(root);
}

/** Mermaid's SVG as XML, which it usually is, or else as the HTML it was serialized from. */
function parseSvg(svg: string): Element | null {
  const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (!xml.querySelector('parsererror') && xml.documentElement.localName === 'svg') return xml.documentElement;
  return new DOMParser().parseFromString(svg, 'text/html').body.querySelector('svg');
}

/**
 * Mermaid diagrams for Streamdown, drawn with the app's settings whatever Streamdown passes, and
 * made inert before they reach the page.
 */
export const mermaidPlugin: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid: () => ({
    initialize: () => {},
    async render(id, source) {
      const mermaid = await loadMermaid();
      const { svg } = await mermaid.render(id, source);
      return { svg: inertSvg(svg) };
    },
  }),
};

/**
 * A diagram Mermaid can't draw shows its source, as the text floor would. While the fence is
 * still arriving it shows the source alone, since a half-written diagram rarely parses.
 */
export function MermaidSource({ chart }: MermaidErrorComponentProps) {
  const arriving = useIsCodeFenceIncomplete();
  return (
    <div className="grid gap-1 p-3 text-xs" data-slot="mermaid-source">
      {!arriving && <p className="text-muted-foreground">Mermaid couldn't draw this diagram.</p>}
      <pre className="overflow-x-auto font-mono whitespace-pre">{chart}</pre>
    </div>
  );
}
