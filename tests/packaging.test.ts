import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
};

const peerKeys = Object.keys(packageJson.peerDependencies ?? {});
const depKeys = Object.keys(packageJson.dependencies ?? {});

const HOST_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "typebox",
];

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
