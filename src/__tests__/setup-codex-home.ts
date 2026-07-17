/**
 * Isolate CODEX_HOME for every unit test so CLI session persistence cannot
 * read/write the developer's real ~/.codex/codeg-codex-acp-cli-sessions.json.
 *
 * Without this, loadSession tests that use fixed ids (session-1, load-id, …)
 * fail with "legacy CLI runtime and cannot be resumed" when a previous CLI
 * test (or a parallel run) polluted the real session map — and also re-pollute
 * it via CodexCliRuntime.threadForSession → refreshAndPersistSession.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach} from "vitest";

const createdHomes: string[] = [];

beforeEach(() => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-vitest-home-"));
    createdHomes.push(codexHome);
    // Prefer mutating process.env (not only vi.stubEnv) so later
    // vi.unstubAllEnvs() still leaves tests on an isolated home rather than
    // restoring the developer's real ~/.codex.
    process.env["CODEX_HOME"] = codexHome;
});

afterEach(() => {
    while (createdHomes.length > 0) {
        const home = createdHomes.pop();
        if (!home) {
            continue;
        }
        try {
            fs.rmSync(home, {recursive: true, force: true});
        } catch {
            // Windows may keep a handle briefly; tmp cleanup is best-effort.
        }
    }
});
