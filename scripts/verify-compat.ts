import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("Run this script with npm run check:compat")
const bun = process.env.BUN_BIN || "bun"
const probe = spawnSync(bun, ["--version"], { encoding: "utf8" })
if (probe.status !== 0) throw new Error("Bun is required. Set BUN_BIN to its executable path.")
const root = mkdtempSync(join(tmpdir(), "triage-compat-"))
const hostModule = import.meta.resolve("@opencode/plugin/host")

function npm(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [npmCli!, ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

try {
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", root], resolve(import.meta.dirname, "..")))
  const archive = join(root, packed[0].filename)
  const harness = `
    import assert from "node:assert/strict";
    import {mkdirSync, writeFileSync, existsSync} from "node:fs";
    import {join} from "node:path";
    globalThis.fetch = async () => new Response("{}");
    const root = process.cwd();
    const path = join(root, ".agents/skills/compat-backup/SKILL.md");
    mkdirSync(join(path, ".."), {recursive:true});
    writeFileSync(path, "---\\nname: compat-backup\\ndescription: compat-backup workflow\\n---\\nBackup instructions.");
    const legacy = await import("opencode-triage");
    assert.deepEqual(Object.keys(legacy), ["server"]);
    for (const factory of Object.values(legacy)) {
      assert.equal(typeof factory, "function");
      const hooks = await factory({worktree:root,client:{tui:{showToast:async()=>{}}}}, {autoHide:false,semanticMatching:false});
      try {
        const context = {abort:new AbortController().signal};
        const result = await hooks.tool.triage.execute({query:"compat backup"}, context);
        assert.ok(result.includes('skill({ name: "compat-backup" })'));
        const body = await hooks.tool["load-skill"].execute({name:"compat-backup"}, context);
        assert.match(body, /Backup instructions/);
      } finally {await hooks.dispose?.()}
    }
    assert.equal(existsSync(join(root,"node_modules/@opencode/plugin")), false);
    const {Host} = await import(${JSON.stringify(hostModule)});
    const entry = Host.resolve({directory:join(root,"node_modules/opencode-triage")}).server;
    assert.ok(entry.endsWith("src/server.ts"));
    const {default: native} = await Host.load(entry);
    assert.equal(native.id, "opencode-triage");
    const tools = new Map();
    const registration = () => ({dispose:async()=>{}});
    const cleanup = await native.setup({
      location:{directory:root,project:{canonical:root}}, options:{autoHide:false,semanticMatching:false},
      tool:{transform:async edit => {edit({add:t=>tools.set(t.name,t)});return registration()}},
      skill:{list:async()=>({data:[{id:"native-backup",name:"compat-backup",path}]}),reload:async()=>{},transform:async()=>registration()},
      session:{hook:async()=>registration()}, permission:{assert:async()=>{}}
    });
    try {
      const result = await tools.get("triage").execute({query:"compat backup"}, {signal:new AbortController().signal});
      assert.ok(result.content.includes('skill({ id: "native-backup" })'));
    } finally {await cleanup?.()}
  `
  for (const version of ["1.14.17", "1.19.5"]) {
    const directory = join(root, version)
    mkdirSync(directory)
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "triage-compat", version: "1.0.0", private: true, type: "module" }))
    npm(["install", archive, `@opencode-ai/plugin@${version}`, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], directory)
    const script = join(directory, "verify.mjs")
    writeFileSync(script, harness)
    const result = spawnSync(bun, [script], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, HOME: join(directory, "home"), USERPROFILE: join(directory, "home") },
    })
    assert.equal(result.status, 0, result.stderr)
    console.log(`Installed package: V1 SDK ${version}, V2 SDK 2.3.0 host resolution and tool execution passed`)
  }
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + "triage-compat-"))
  rmSync(root, { recursive: true, force: true })
}
