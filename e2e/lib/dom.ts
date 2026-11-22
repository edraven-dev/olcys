/** The few DOM members the e2e helpers touch inside `evaluate` callbacks (the program has no DOM typings). */
export interface DomNode {
  id: string;
  checked: boolean;
  disabled: boolean;
  style: Record<string, string>;
  querySelectorAll(selector: string): DomNode[];
  scrollIntoView(options: { behavior: string; block: string }): void;
}
