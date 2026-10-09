// Argument parser for the /herdr-fork command
// (docs/feature-impl/20261007-herdr-fork/2_requirements__herdr-fork.md, §3.2).
//
// Pure and synchronous: it only maps the raw command argument string onto a
// placement + optional starter instruction. No I/O, no Herdr, no shell.
//
// Rules (requirements §3.2):
// - leading quote protection: an input starting with a single or double quote
//   is ALWAYS the instruction, never a placement (placement defaults to right)
// - first token right|down|tab (case-insensitive, ASCII) selects the placement;
//   whitespace following the keyword (space, tab, ...) is the separator;
//   the remainder is the instruction
// - any other first token: placement stays right and the WHOLE input is the
//   instruction (a leading keyword-like word that is not quoted stays the
//   instruction — e.g. "righteous idea" is not a split direction)
// - empty/whitespace input: right, no instruction

export type ForkPlacement = "right" | "down" | "tab";

export interface ParsedForkArgs {
  placement: ForkPlacement;
  /** undefined when no starter instruction was given. */
  instruction?: string;
}

const PLACEMENTS: ReadonlySet<string> = new Set(["right", "down", "tab"]);
const QUOTE_CHARS = new Set(['"', "'"]);

function unquoteLeading(input: string): { value: string; balanced: boolean } {
  const q = input.charAt(0);
  const last = input.charAt(input.length - 1);
  const balanced = input.length >= 2 && last === q && input.indexOf(q, 1) === input.length - 1;
  return { value: balanced ? input.slice(1, -1) : input, balanced };
}

export function parseForkArgs(input: string): ParsedForkArgs {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { placement: "right" };
  }
  if (QUOTE_CHARS.has(trimmed.charAt(0))) {
    // Leading quote protection (requirements §3.2): the entire UNQUOTED
    // content is the instruction; it never selects a placement. The
    // surrounding protective quotes are removed, the inner content is kept
    // verbatim. No shell-escape processing: a second quote anywhere else is
    // just content, and an unmatched leading quote leaves the input as-is.
    const { value: instruction } = unquoteLeading(trimmed);
    return { placement: "right", instruction };
  }
  // A bare leading quote followed by nothing is not a directive; the whole
  // input is the instruction (same outcome as the quote rule above).
  const ws = trimmed.search(/\s/);
  const first = (ws === -1 ? trimmed : trimmed.slice(0, ws)).toLowerCase();
  if (PLACEMENTS.has(first)) {
    const rest = trimmed.slice(first.length).trim();
    const placement = first as ForkPlacement;
    return {
      placement,
      ...(rest.length > 0 ? { instruction: rest } : {}),
    };
  }
  return { placement: "right", instruction: trimmed };
}
