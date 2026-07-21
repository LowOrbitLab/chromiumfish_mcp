/** HTML-to-ARIA implicit role mapping (no DOM or Playwright imports, so it stays unit-testable). */

export interface RoleInput {
  /** Lowercased tag name. */
  tag: string;
  /** Lowercased input type; empty for non-input elements. */
  type: string;
  /** Whether an input is bound to a datalist. */
  hasList: boolean;
  multiple: boolean;
  size: number;
}

const BUTTON_INPUT_TYPES = ["button", "submit", "reset", "image"];
const TEXT_INPUT_TYPES = ["text", "email", "tel", "url", "search"];

/**
 * Implicit ARIA role for the elements snapshot enumerates, or "" when HTML defines none.
 * Callers print the role so agents can target elements with Playwright's role= engine,
 * which is why this stays a conservative subset: a wrong role sends the agent off to build
 * a selector that cannot match, which is worse than admitting there is no role.
 *
 * Anchors map to link because snapshot only enumerates a[href]; a bare <a> is generic.
 */
export function implicitAriaRole(input: RoleInput): string {
  switch (input.tag) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "textarea":
      return "textbox";
    case "select":
      return input.multiple || input.size > 1 ? "listbox" : "combobox";
    case "input":
      break;
    default:
      return "";
  }

  if (BUTTON_INPUT_TYPES.includes(input.type)) return "button";
  if (input.type === "checkbox" || input.type === "radio") return input.type;
  if (input.type === "range") return "slider";
  if (input.type === "number") return "spinbutton";
  if (TEXT_INPUT_TYPES.includes(input.type)) {
    if (input.hasList) return "combobox";
    return input.type === "search" ? "searchbox" : "textbox";
  }
  // password, file, color, and the date/time inputs have no mapped role.
  return "";
}

/** Role shown in snapshot output: an explicit role attribute wins, then HTML, then the tag. */
export function snapshotRole(input: RoleInput & { explicitRole: string }): string {
  return (input.explicitRole || implicitAriaRole(input) || input.tag).slice(0, 40);
}
