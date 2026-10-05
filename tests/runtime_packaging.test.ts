import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../../", import.meta.url));

test("runtime: extracted package keeps Herdr runtime and integrates optional system profile command", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr runtime spaces "));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: root, encoding: "utf8" }));
    execFileSync("tar", ["-xzf", path.join(dir, packed[0].filename), "-C", dir]);
    const scripts = path.join(dir, "package/skills/subagent-herdr-supervision/scripts");
    for (const name of ["herdr-worker.sh", "pi-worker-runtime.sh", "herdr_agent_observation_lib.sh"]) assert.ok(existsSync(path.join(scripts, name)), name);
    assert.equal(existsSync(path.join(scripts, "pi-profile.sh")), false, "profile manager must not ship in extension");
    assert.ok(statSync(path.join(scripts, "herdr-worker.sh")).mode & 0o111, "packed worker entrypoint must remain executable");
    const home = path.join(dir, "home"), bin = path.join(dir, "bin"), cwd = path.join(dir, "unrelated cwd"), capture = path.join(dir, "capture");
    for (const d of [home, bin, cwd]) mkdirSync(d);
    writeFileSync(path.join(bin, "pi"), `#!/bin/bash\nif [[ " $* " == *" --list-models "* ]]; then printf 'test model\\n'; else printf '%s\\n' "$PI_CODING_AGENT_DIR" "$PI_WRITE_GUARD_DIRS" "$@" > "$CAPTURE"; fi\n`, { mode: 0o755 });
    const profileCapture = path.join(dir, "profile calls");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, CAPTURE: capture, PROFILE_CAPTURE: profileCapture, PI_WORKER_DEFAULT_MODEL: "test/model:off" };
    delete env.PI_WORKER_PROFILE; delete env.PI_CODING_AGENT_DIR; delete env.PI_SUBAGENT_RUNTIME_DIR;
    const run = (mode: string, changes: Record<string,string> = {}) => spawnSync("/bin/bash", [path.join(scripts, "herdr-worker.sh"), "--mode", mode, "--"], { cwd, env: { ...env, ...changes }, encoding: "utf8" });
    const reporter = (profile: string) => {
      const agent = profile === "default" ? path.join(home, ".pi/agent") : path.join(home, `.pi/profiles/${profile}/agent`);
      mkdirSync(path.join(agent, "extensions"), { recursive: true });
      writeFileSync(path.join(agent, "extensions/herdr-agent-state.ts"), "// fixture"); return agent;
    };
    const direct = reporter("default");
    let r = run("editable"); assert.equal(r.status, 0, r.stderr);
    let args = readFileSync(capture, "utf8");
    assert.ok(args.includes(path.join(scripts, "../../../index.ts")), "self-extension must load from the package root index.ts so Pi labels it by package name");
    assert.ok(existsSync(path.join(scripts, "../../../index.ts")), "package root index.ts entry must ship");
    assert.ok(!args.includes("https://github.com/cgint/pi-subagent-herdr"));
    assert.ok(!args.includes("--dm-read=1"));
    const minimal = reporter("minimal");
    r = run("readonly"); assert.equal(r.status, 0, r.stderr);
    args = readFileSync(capture, "utf8"); assert.ok(args.startsWith("\n.\n"), "no system wrapper means direct Pi, even with profiles on disk");
    assert.match(args, /--dm-read=1/);
    r = run("editable", { PI_WORKER_PROFILE: "minimal" }); assert.equal(r.status, 2); assert.match(r.stderr, /requires system pi-profile/);
    writeFileSync(path.join(bin, "pi-profile"), `#!/bin/bash\nprintf '%s\\n' "$1" >> "$PROFILE_CAPTURE"\nif [[ "$1" == default ]]; then export PI_CODING_AGENT_DIR="$HOME/.pi/agent"; else export PI_CODING_AGENT_DIR="$HOME/.pi/profiles/$1/agent"; fi\nshift\nexec pi "$@"\n`, { mode: 0o755 });
    r = run("readonly"); assert.equal(r.status, 0, r.stderr);
    args = readFileSync(capture, "utf8"); assert.ok(args.startsWith(`${minimal}\n.\n`));
    assert.match(args, /--dm-read=1/); assert.match(args, /read,bash,grep,find,ls/);
    const calls = readFileSync(profileCapture, "utf8"); assert.equal(calls, "minimal\nminimal\n", "system wrapper used for both probe and launch");
    r = run("editable", { PI_WORKER_PROFILE: "--update-all" }); assert.equal(r.status, 2); assert.match(r.stderr, /invalid PI_WORKER_PROFILE/);
    assert.equal(readFileSync(profileCapture, "utf8"), calls, "option-like profile never reaches system wrapper");
    const partner = reporter("partner");
    r = run("editable", { PI_WORKER_PROFILE: "partner" }); assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(capture, "utf8").startsWith(`${partner}\n`));
    r = run("editable", { PI_WORKER_PROFILE: "default" }); assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(capture, "utf8").startsWith(`${direct}\n`));
    r = run("editable", { PI_WORKER_DEFAULT_MODEL: "invalid" }); assert.equal(r.status, 2); assert.match(r.stderr, /invalid PI_WORKER_DEFAULT_MODEL/);
    rmSync(path.join(home, ".pi/profiles/minimal"), { recursive: true });
    r = run("editable"); assert.notEqual(r.status, 0); assert.match(r.stderr, /required trusted extension not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
