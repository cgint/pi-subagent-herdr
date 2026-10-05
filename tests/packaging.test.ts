import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// tsconfig.build.json compiles tests/packaging.test.ts into .test-build/tests/packaging.test.js
// (rootDir = repo root, outDir = .test-build). From the compiled location, the root
// package.json is two levels up, hence '../../package.json'. The documented npm test
// script always runs the compiled file, so this is the only layout the test supports.
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  pi?: {
    skills?: string[];
  };
};

const peerKeys = Object.keys(packageJson.peerDependencies ?? {});
const depKeys = Object.keys(packageJson.dependencies ?? {});

const HOST_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "typebox",
];

const BUNDLED_SKILLS = [
  "firstmate",
  "bootstrap-pairing-memory",
  "grounded-pairing-discipline",
  "sub-agent-handoff",
  "sub-agent-herdr-supervisor",
];

test("packaging: bundles declared skills in the package artifact", () => {
  assert.ok(packageJson.files?.includes("skills"));
  assert.deepEqual(
    packageJson.pi?.skills,
    BUNDLED_SKILLS.map((name) => `./skills/${name}`),
  );

  for (const name of BUNDLED_SKILLS) {
    const skill = new URL(`../../skills/${name}/SKILL.md`, import.meta.url);
    assert.ok(existsSync(skill), `expected bundled skill ${name}`);
    const contents = readFileSync(skill, "utf8");
    assert.match(contents, new RegExp(`^---\\nname: ${name}\\n`, "m"));
    assert.match(contents, /^description: .+/m);
  }
});

test("packaging: host packages are declared as wildcard peer dependencies", () => {
  for (const name of HOST_PACKAGES) {
    assert.ok(peerKeys.includes(name), `expected peerDependency ${name}`);
    assert.equal(
      packageJson.peerDependencies?.[name],
      "*",
      `expected peerDependency ${name} pinned to *`,
    );
  }
});

test("packaging: host packages are not executable dependencies", () => {
  for (const name of HOST_PACKAGES) {
    assert.ok(!depKeys.includes(name), `dependencies must not contain ${name}`);
  }
});

test("packaging: host packages are dev-pinned to exact installed host versions", () => {
  assert.equal(
    packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
    "1.0.0",
  );
  assert.equal(
    packageJson.devDependencies?.["@earendil-works/pi-ai"],
    "1.0.0",
  );
  assert.equal(packageJson.devDependencies?.["typebox"], "1.3.27");
});
