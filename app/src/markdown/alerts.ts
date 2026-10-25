type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
};

/** GitHub's alert kinds, as a blockquote's first line names them: `> [!NOTE]`. */
export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/**
 * A blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`,
 * as GitHub writes alerts, loses the marker and carries its kind as `data-alert`, which the message
 * draws as a labelled alert. No HTML is involved.
 */
export function alerts() {
  const walk = (node: MarkdownNode) => {
    const first = node.type === 'blockquote' ? node.children?.[0] : undefined;
    const text = first?.type === 'paragraph' ? first.children?.[0] : undefined;
    const marker = text?.type === 'text' ? MARKER.exec(text.value ?? '') : null;
    if (first && text && marker) {
      text.value = (text.value ?? '').slice(marker[0].length);
      if (text.value === '') first.children?.shift();
      if (first.children?.[0]?.type === 'break') first.children.shift();
      if (first.children?.length === 0) node.children?.shift();
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataAlert: marker[1].toLowerCase() } };
    }
    node.children?.forEach(walk);
  };
  return walk;
}
