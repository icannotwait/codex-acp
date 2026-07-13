import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodexMockTestFixture } from "../acp-test-utils";

describe("CodexACPAgent - legacy CLI sessions", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("requires a new session instead of resuming a persisted CLI-runtime id", async () => {
        const codexHome = await mkdtemp(join(tmpdir(), "codex-acp-legacy-cli-"));
        const sessionId = "legacy-codeg-session";

        try {
            vi.stubEnv("CODEX_ACP_USE_CLI", "");
            vi.stubEnv("CODEX_HOME", codexHome);
            await writeFile(
                join(codexHome, "codeg-codex-acp-cli-sessions.json"),
                JSON.stringify({
                    [sessionId]: {
                        sessionId,
                        cliThreadId: "codex-thread-created-by-cli-runtime",
                        cliRolloutPath: null,
                        cwd: codexHome,
                        lastPrompt: null,
                        updatedAt: Date.now(),
                    },
                }),
                "utf8"
            );

            const fixture = createCodexMockTestFixture();

            await expect(
                fixture.getCodexAcpClient().resumeSession({
                    sessionId,
                    cwd: codexHome,
                    mcpServers: [],
                })
            ).rejects.toThrow(
                "This Codex session was created by the legacy CLI runtime and cannot be resumed. Create a new session."
            );
            expect(fixture.getCodexConnectionEvents([])).toEqual([]);
        } finally {
            await rm(codexHome, { recursive: true, force: true });
        }
    });
});
