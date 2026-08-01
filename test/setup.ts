import { afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Source modules resolve cache and credential paths from homedir() at import time, and
// several suites rmSync/writeFileSync those paths. Bun caches os.homedir() at process
// start, so assigning process.env.HOME here would be a silent no-op and the suite would
// wipe a developer's live Kiro state — `npm test` launches bun with a scratch HOME
// instead. Fail loudly rather than delete real files.
const testHome = homedir();
if (!testHome.startsWith(tmpdir())) {
  throw new Error(`HOME must be a scratch directory, got ${testHome}. Run \`npm test\`, not \`bun test\`.`);
}

process.env.USERPROFILE = testHome;
process.env.APPDATA = join(testHome, "AppData", "Roaming");
process.env.PATH = testHome;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
