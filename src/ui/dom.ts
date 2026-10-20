/** Petits utilitaires de construction DOM (sans framework). */

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  onClick?: (e: MouseEvent) => void;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.onClick) {
    const handler = props.onClick;
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      handler(e as MouseEvent);
    });
  }
  // Les boutons ne prennent pas le focus : sinon Espace/Entrée les réactiveraient
  // au lieu d'atteindre les raccourcis du jeu.
  if (tag === 'button') node.addEventListener('mousedown', (e) => e.preventDefault());
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Racine de l'interface (div#ui de index.html). */
export function uiRoot(): HTMLElement {
  const root = document.getElementById('ui');
  if (!root) throw new Error('#ui introuvable dans index.html');
  return root;
}

/** Met à jour un texte seulement s'il a changé (évite de casser les survols et la sélection). */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
