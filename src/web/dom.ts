export type Child = Node | string | number | null | undefined | false;
export type Attrs = Readonly<Record<string, string | boolean | undefined>>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(node: Element, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : value);
  }
}

function toNodes(children: readonly Child[]): Node[] {
  const nodes: Node[] = [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    nodes.push(
      typeof child === 'object'
        ? child
        : document.createTextNode(String(child)),
    );
  }
  return nodes;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  apply(node, attrs);
  node.append(...toNodes(children));
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, attrs);
  node.append(...toNodes(children));
  return node;
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(...toNodes(children));
}

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
