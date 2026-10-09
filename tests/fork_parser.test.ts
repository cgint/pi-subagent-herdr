// Node:test suite for fork-parser.ts (pure /herdr-fork argument parsing).
//
// Requirements (docs/feature-impl/20261007-herdr-fork/2_requirements__herdr-fork.md
// §3.2): default right, explicit placement keywords, positional instruction,
// leading quote protection (the UNQUOTED content is the instruction),
// whitespace handling, and explicit unmatched-quote behaviour (verbatim).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseForkArgs } from "../fork-parser.js";

function expectParsed(input: string, placement: string, instruction?: string): void {
  const r = parseForkArgs(input);
  assert.equal(r.placement, placement, `placement for ${JSON.stringify(input)}`);
  assert.equal(r.instruction, instruction, `instruction for ${JSON.stringify(input)}`);
}

test("parser: empty input -> right, no instruction", () => {
  expectParsed("", "right");
  expectParsed("   ", "right");
});

test("parser: single-word placement only", () => {
  for (const p of ["right", "down", "tab"] as const) {
    expectParsed(p, p);
  }
  expectParsed("tab ", "tab");
  expectParsed("  down", "down");
});

test("parser: placement keywords are case-insensitive", () => {
  expectParsed("TAB", "tab");
  expectParsed("Down", "down");
  expectParsed("RIGHT hello", "right", "hello");
});

test("parser: placement + instruction", () => {
  expectParsed("tab write the acceptance test", "tab", "write the acceptance test");
  expectParsed("down   investigate the failing test", "down", "investigate the failing test");
});

test("parser: whitespace delimiters (space, tab) after the keyword select the placement", () => {
  expectParsed("tab\tinvestigate issue", "tab", "investigate issue");
  expectParsed("down\tcheck the build", "down", "check the build");
  expectParsed("right\tfixed", "right", "fixed");
  expectParsed("tab\t", "tab");
  expectParsed("\t\tdown\tnested", "down", "nested");
});

test("parser: first word is not a placement -> whole input is the instruction", () => {
  expectParsed("investigate the failing test", "right", "investigate the failing test");
  // A keyword-like prefix that is not a keyword stays the instruction.
  expectParsed("righteous idea about tables", "right", "righteous idea about tables");
  // "tabor" is not "tab".
  expectParsed("tabor the drums", "right", "tabor the drums");
});

test("parser: leading single quote -> surrounding quotes removed, inner content is the instruction", () => {
  // Requirements §3.2: the ENTIRE UNQUOTED content is the instruction — the
  // protective quotes must not reach the forked session.
  expectParsed("'down in the cellar is a bug'", "right", "down in the cellar is a bug");
});

test("parser: leading double quote -> surrounding quotes removed, inner content is the instruction", () => {
  expectParsed('"right now do the thing"', "right", "right now do the thing");
  expectParsed('"tab into the void"', "right", "tab into the void");
});

test("parser: unmatched leading quote -> input kept verbatim (explicit, un-parsed)", () => {
  // No closing quote of the leading kind: nothing may be stripped. The
  // leading quote is content, not protection.
  expectParsed("'down in the cellar", "right", "'down in the cellar");
  expectParsed('"right now do the thing', "right", '"right now do the thing');
  // A lone quote is not a directive; whole input is the instruction.
  expectParsed("'", "right", "'");
  expectParsed('"', "right", '"');
});

test("parser: inner quotes are content, no shell-escape processing", () => {
  // A double quote inside single quotes is content, never a terminator.
  expectParsed("'don\"t split that'", "right", 'don"t split that');
  // A second single quote inside does not end the protective quoting: the
  // input's LAST character is not the leading quote, so nothing is stripped.
  expectParsed("'down, don't panic'", "right", "'down, don't panic'");
  // Inner spaces survive untouched.
  expectParsed('"  spaced   content  "', "right", "  spaced   content  ");
});

test("parser: internal spacing is preserved inside the instruction", () => {
  expectParsed("tab    spaced   instruction", "tab", "spaced   instruction");
});
