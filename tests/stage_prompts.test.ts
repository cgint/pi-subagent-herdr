import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// Mirrors tests/packaging.test.ts: tsconfig.build.json compiles this file into
// .test-build/tests/stage_prompts.test.js (rootDir = repo root, outDir =
// .test-build), so the repo root is two levels up from the compiled location.
// The documented npm test script always runs the compiled file.
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  files?: string[];
  pi?: {
    prompts?: string[];
  };
};

const STAGE_PROMPTS = [
  "stage-explore",
  "stage-implement",
  "stage-review",
];

// Expected frontmatter descriptions: assert exact strings so accidental
// frontmatter edits fail the test instead of silently changing completion text.
const EXPECTED_DESCRIPTIONS: Record<string, string> = {
  "stage-explore":
    "Explore an investigation brief for Herdr sub-agent work — bounded question, evidence first, no edits",
  "stage-implement":
    "Implement a bounded change for Herdr sub-agent work — make the requested change, keep scope tight, verify it",
  "stage-review":
    "Critically review relevant Herdr sub-agent work — correctness, risks, gaps, missing verification; no edits unless asked",
};

// Forbidden content: templates must stay guidance-only (no runtime
// orchestration, model/profile selection, or .sub_agent_conf usage).
const FORBIDDEN = [".sub_agent_conf", "pi.registerCommand", "setModel"];

test("packaging: bundles declared stage prompt templates", () => {
  assert.ok(packageJson.files?.includes("prompts"));
  assert.deepEqual(
    packageJson.pi?.prompts,
    STAGE_PROMPTS.map((name) => `./prompts/${name}.md`),
  );

  const promptsDirectory = new URL("../../prompts/", import.meta.url);
  assert.deepEqual(
    readdirSync(promptsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort(),
    [...STAGE_PROMPTS].map((name) => `${name}.md`).sort(),
    "prompts directory must not retain undeclared templates",
  );
});

test("stage prompts: declare description and optional argument hint", () => {
  for (const name of STAGE_PROMPTS) {
    const file = new URL(`../../prompts/${name}.md`, import.meta.url);
    assert.ok(existsSync(file), `expected stage prompt ${name}`);
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /^---\n/m, `${name}: must start with frontmatter`);
    assert.match(
      contents,
      new RegExp(`^description: ${EXPECTED_DESCRIPTIONS[name]}$`, "m"),
      `${name}: description must match packaged expectation`,
    );
    assert.match(
      contents,
      /^argument-hint: "\[.+\]"$/m,
      `${name}: argument-hint must be quoted and optional ([...])`,
    );
  }
});

test("stage prompts: forward the optional user text", () => {
  for (const name of STAGE_PROMPTS) {
    const contents = readFileSync(
      new URL(`../../prompts/${name}.md`, import.meta.url),
      "utf8",
    );
    assert.match(
      contents,
      /\$\{1:-/m,
      `${name}: must use a ${"$1"}:-... default so user text is forwarded`,
    );
  }
});

test("stage prompts: stay guidance-only (no orchestration, model or conf)", () => {
  for (const name of STAGE_PROMPTS) {
    const contents = readFileSync(
      new URL(`../../prompts/${name}.md`, import.meta.url),
      "utf8",
    );
    for (const forbidden of FORBIDDEN) {
      assert.doesNotMatch(
        contents,
        new RegExp(escaped(forbidden), "i"),
        `${name}: must not reference ${forbidden}`,
      );
    }
  }
});

test("readme: documents the stage prompt template commands", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  for (const name of STAGE_PROMPTS) {
    assert.ok(
      readme.includes(`/${name} [`),
      `README must document /${name} with its optional argument`,
    );
  }
  assert.ok(
    readme.includes("pi.prompts"),
    "README must mention the pi.prompts manifest",
  );
  assert.match(
    readme,
    /do not\s+automatically launch/i,
    "README must state templates do not automatically launch workers",
  );
});

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
