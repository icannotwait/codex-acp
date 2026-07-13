import { describe, expect, it } from "vitest";

import {
    resolveCodexCommandLaunch,
    nodeExecutableForJavaScriptEntrypoint,
    resolveCodexLaunch,
} from "../CodexJsonRpcConnection";

describe("resolveCodexLaunch", () => {
    it("launches a Windows JavaScript Codex entrypoint through Node", () => {
        const codexPath = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
        const nodePath = "C:\\Program Files\\nodejs\\node.exe";

        expect(resolveCodexLaunch(codexPath, true, nodePath)).toEqual({
            command: nodePath,
            args: [codexPath, "app-server"],
            shell: false,
        });
    });

    it("uses host Node instead of the compiled Bun sidecar for a JavaScript entrypoint", () => {
        expect(
            nodeExecutableForJavaScriptEntrypoint(true, "C:\\Codeg\\codex-acp.exe"),
        ).toBe("node");
        expect(
            nodeExecutableForJavaScriptEntrypoint(false, "C:\\Program Files\\nodejs\\node.exe"),
        ).toBe("C:\\Program Files\\nodejs\\node.exe");
    });

    it("launches a Windows JavaScript Codex CLI command through Node", () => {
        const codexPath = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
        const nodePath = "C:\\Program Files\\nodejs\\node.exe";

        expect(
            resolveCodexCommandLaunch(codexPath, ["exec", "--json"], true, nodePath),
        ).toEqual({
            command: nodePath,
            args: [codexPath, "exec", "--json"],
            shell: false,
        });
    });
});
