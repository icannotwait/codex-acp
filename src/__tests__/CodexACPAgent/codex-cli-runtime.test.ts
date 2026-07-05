import {afterEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {CodexCliRuntime, mcpServerConfigArgs} from "../../CodexCliRuntime";
import {AgentMode} from "../../AgentMode";
import {ModelId} from "../../ModelId";
import type {ServerNotification} from "../../app-server";

describe("CodexCliRuntime", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("converts ACP MCP servers to Codex CLI config overrides", () => {
        const server: McpServerStdio = {
            name: "codeg-delegate",
            command: "/tmp/codeg-mcp",
            args: ["--stdio", "delegate"],
            env: [{name: "CODEG_TOKEN", value: "secret"}],
        };

        expect(mcpServerConfigArgs([server])).toEqual([
            "-c",
            "mcp_servers.codeg-delegate.command=\"/tmp/codeg-mcp\"",
            "-c",
            "mcp_servers.codeg-delegate.args=[\"--stdio\", \"delegate\"]",
            "-c",
            "mcp_servers.codeg-delegate.env={CODEG_TOKEN=\"secret\"}",
        ]);
    });

    it("maps codex exec JSONL MCP tool calls into session notifications", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-test-"));
        const fakeCodex = path.join(temp, "codex");
        fs.writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"cli-thread-1"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.started","item":{"id":"mcp-1","type":"mcp_tool_call","server":"codeg-delegate","tool":"delegate_to_agent","arguments":{"task":"check"},"status":"in_progress"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"mcp-1","type":"mcp_tool_call","server":"codeg-delegate","tool":"delegate_to_agent","arguments":{"task":"check"},"status":"completed","result":{"content":[{"type":"text","text":"done"}],"structuredContent":null,"_meta":null}}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"done"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":13}}'
        `, "utf8");
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PATH", fakeCodex);
        vi.stubEnv("CODEX_HOME", path.join(temp, "codex-home"));

        const runtime = new CodexCliRuntime();
        const session = runtime.createSession({cwd: temp, mcpServers: []}, []);
        const notifications: ServerNotification[] = [];
        runtime.onServerNotification(session.sessionId, event => {
            notifications.push(event);
        });

        const completed = await runtime.runPrompt({
            request: {
                sessionId: session.sessionId,
                prompt: [{type: "text", text: "delegate"}],
            },
            agentMode: AgentMode.getInitialAgentMode(),
            modelId: ModelId.create("gpt-5", "medium"),
            serviceTier: null,
            disableSummary: false,
            cwd: temp,
            additionalDirectories: [],
        });

        expect(completed?.turn.status).toBe("completed");
        expect(notifications.map(event => event.method)).toEqual([
            "turn/started",
            "item/started",
            "item/completed",
            "item/agentMessage/delta",
            "thread/tokenUsage/updated",
            "turn/completed",
        ]);
        expect(notifications[1]).toMatchObject({
            method: "item/started",
            params: {
                item: {
                    type: "mcpToolCall",
                    server: "codeg-delegate",
                    tool: "delegate_to_agent",
                    status: "inProgress",
                },
            },
        });
        expect(notifications[2]).toMatchObject({
            method: "item/completed",
            params: {
                item: {
                    type: "mcpToolCall",
                    status: "completed",
                    result: {
                        content: [{type: "text", text: "done"}],
                    },
                },
            },
        });

        fs.rmSync(temp, {recursive: true, force: true});
    });

    it("places parent exec options before the resume subcommand", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-test-"));
        const fakeCodex = path.join(temp, "codex");
        const argsLog = path.join(temp, "args.jsonl");
        fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({type: "thread.started", thread_id: "cli-thread-1"}));
console.log(JSON.stringify({type: "turn.completed"}));
        `, "utf8");
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PATH", fakeCodex);
        vi.stubEnv("CODEX_HOME", path.join(temp, "codex-home"));
        vi.stubEnv("ARGS_LOG", argsLog);

        const runtime = new CodexCliRuntime();
        const session = runtime.createSession({cwd: temp, mcpServers: []}, [path.join(temp, "extra")]);
        const basePrompt = {
            agentMode: AgentMode.getInitialAgentMode(),
            modelId: ModelId.create("gpt-5", "medium"),
            serviceTier: null,
            disableSummary: false,
            cwd: temp,
            additionalDirectories: [path.join(temp, "extra")],
        };

        await runtime.runPrompt({
            ...basePrompt,
            request: {
                sessionId: session.sessionId,
                prompt: [{type: "text", text: "first"}],
            },
        });
        await runtime.runPrompt({
            ...basePrompt,
            request: {
                sessionId: session.sessionId,
                prompt: [{type: "text", text: "second"}],
            },
        });

        const invocations = fs.readFileSync(argsLog, "utf8")
            .trim()
            .split("\n")
            .map(line => JSON.parse(line) as string[]);
        expect(invocations[1]).toEqual([
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-C",
            temp,
            "-m",
            "gpt-5",
            "-s",
            "workspace-write",
            "--add-dir",
            path.join(temp, "extra"),
            "resume",
            "cli-thread-1",
            "second",
        ]);

        fs.rmSync(temp, {recursive: true, force: true});
    });

    it("keeps the Codex rollout path when loading a persisted CLI session", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-test-"));
        const fakeCodex = path.join(temp, "codex");
        const codexHome = path.join(temp, "codex-home");
        const rolloutDir = path.join(codexHome, "sessions", "2026", "07", "05");
        const rolloutPath = path.join(rolloutDir, "rollout-2026-07-05T10-00-00-cli-thread-1.jsonl");
        fs.mkdirSync(rolloutDir, {recursive: true});
        fs.writeFileSync(rolloutPath, [
            JSON.stringify({
                type: "session_meta",
                payload: {
                    session_id: "cli-thread-1",
                    id: "cli-thread-1",
                    cwd: temp,
                    timestamp: "2026-07-05T10:00:00.000Z",
                    cli_version: "0.142.5",
                    source: "exec",
                    thread_source: "user",
                    model_provider: "openai",
                },
            }),
            JSON.stringify({
                type: "event_msg",
                payload: {
                    type: "user_message",
                    message: "first",
                    images: [],
                    local_images: [],
                },
            }),
            JSON.stringify({
                type: "response_item",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{type: "output_text", text: "history reply"}],
                },
            }),
        ].join("\n") + "\n", "utf8");
        fs.writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"cli-thread-1"}'
printf '%s\\n' '{"type":"turn.completed"}'
`, "utf8");
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PATH", fakeCodex);
        vi.stubEnv("CODEX_HOME", codexHome);

        const runtime = new CodexCliRuntime();
        const session = runtime.createSession({cwd: temp, mcpServers: []}, []);

        await runtime.runPrompt({
            request: {
                sessionId: session.sessionId,
                prompt: [{type: "text", text: "first"}],
            },
            agentMode: AgentMode.getInitialAgentMode(),
            modelId: ModelId.create("gpt-5", "medium"),
            serviceTier: null,
            disableSummary: false,
            cwd: temp,
            additionalDirectories: [],
        });

        const aliasPath = path.join(rolloutDir, `codeg-acp-session-${session.sessionId}.jsonl`);
        expect(fs.existsSync(aliasPath)).toBe(true);
        expect(fs.readFileSync(aliasPath, "utf8")).toContain("history reply");
        fs.unlinkSync(aliasPath);

        const loadedRuntime = new CodexCliRuntime();
        const loaded = loadedRuntime.resumeSession({
            sessionId: session.sessionId,
            cwd: temp,
            mcpServers: [],
        }, []);

        expect(loaded.cliThreadId).toBe("cli-thread-1");
        expect(loadedRuntime.threadForSession(loaded.sessionId).path).toBe(rolloutPath);
        expect(fs.existsSync(aliasPath)).toBe(true);

        fs.rmSync(temp, {recursive: true, force: true});
    });
});
