/**
 * Extract `function NAME(...) {...}` from a source string by brace matching.
 * Used to render a closure-internal component (like InstallResultDialog) in a
 * test without exporting it from the bundle.
 */
export function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`cannot find function ${name} in the bundle`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Flatten a stub element tree into its visible text and class names. */
export function flatten(node, out = { text: [], classes: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node));
    return out;
  }
  const className = node.props && node.props.className;
  if (className) out.classes.push(String(className));
  const attrs = node.props || {};
  if (attrs.title) out.text.push(`[title:${attrs.title}]`);
  flatten(node.children, out);
  return out;
}

/** Render an extracted component with `t`, `result`, `failure` supplied. */
export function renderComponent(source, name, props, t) {
  const h = (type, config, ...children) => ({
    type,
    props: config || {},
    children: children.filter((c) => c !== undefined && c !== null),
  });
  const Modal = function Modal() {};
  const Icon = function Icon() {};
  const ICON_PATH = { check: 'check', close: 'close', warn: 'warn' };
  const text = extractFunction(source, name);
  // eslint-disable-next-line no-new-func
  const factory = new Function('h', 'Modal', 'Icon', 'ICON_PATH', `return (${text});`);
  const component = factory(h, Modal, Icon, ICON_PATH);
  return component({ t, ...props });
}
