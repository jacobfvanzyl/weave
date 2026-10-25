type MarkdownNode = {
  type: string;
  alt?: string | null;
  value?: string;
  children?: MarkdownNode[];
};

/**
 * A Markdown image in agent text becomes a link to it, labelled with its alt text: the app never
 * fetches what an agent's text names, and opening the image asks first, as any link does.
 * Reference images become reference links, so their definitions still resolve.
 */
export function imagesAsLinks() {
  const walk = (node: MarkdownNode) => {
    if (node.type === 'image' || node.type === 'imageReference') {
      node.type = node.type === 'image' ? 'link' : 'linkReference';
      node.children = [{ type: 'text', value: node.alt ? `Image: ${node.alt}` : 'Image' }];
      delete node.alt;
    }
    node.children?.forEach(walk);
  };
  return walk;
}
