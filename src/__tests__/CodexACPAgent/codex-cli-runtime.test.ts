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

    it("uses the configured CLI model even when Codeg passes a stale model id", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-test-"));
        const fakeCodex = path.join(temp, "codex");
        const argsLog = path.join(temp, "args.jsonl");
        fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({type: "thread.started", thread_id: "cli-thread-1"}));
console.log(JSON.stringify({type: "turn.completed"}));
        `, "utf8");
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PATH", fakeCodex);
        vi.stubEnv("CODEX_HOME", path.join(temp, "codex-home"));
        vi.stubEnv("CODEX_ACP_CLI_MODEL", "gpt-5.5");
        vi.stubEnv("ARGS_LOG", argsLog);

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

        const invocation = JSON.parse(fs.readFileSync(argsLog, "utf8")) as string[];
        expect(invocation.slice(invocation.indexOf("-m"), invocation.indexOf("-m") + 2)).toEqual([
            "-m",
            "gpt-5.5",
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

    it("emits a compaction notification when Codex CLI records a compacted rollout item", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-test-"));
        const fakeCodex = path.join(temp, "codex");
        const codexHome = path.join(temp, "codex-home");
        fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const threadId = "cli-thread-compact";
const rolloutDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "07", "06");
fs.mkdirSync(rolloutDir, {recursive: true});
fs.writeFileSync(path.join(rolloutDir, "rollout-2026-07-06T00-00-00-cli-thread-compact.jsonl"), [
  JSON.stringify({type: "session_meta", payload: {session_id: threadId, id: threadId, cwd: process.cwd()}}),
  JSON.stringify({type: "compacted", payload: {message: "summary", replacement_history: []}}),
  JSON.stringify({type: "event_msg", payload: {type: "context_compacted"}}),
].join("\\n") + "\\n");
console.log(JSON.stringify({type: "thread.started", thread_id: threadId}));
console.log(JSON.stringify({type: "turn.started"}));
console.log(JSON.stringify({type: "turn.completed"}));
`, "utf8");
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PATH", fakeCodex);
        vi.stubEnv("CODEX_HOME", codexHome);

        const runtime = new CodexCliRuntime();
        const session = runtime.createSession({cwd: temp, mcpServers: []}, []);
        const notifications: ServerNotification[] = [];
        runtime.onServerNotification(session.sessionId, event => {
            notifications.push(event);
        });

        await runtime.runPrompt({
            request: {
                sessionId: session.sessionId,
                prompt: [{type: "text", text: "/compact"}],
            },
            agentMode: AgentMode.getInitialAgentMode(),
            modelId: ModelId.create("gpt-5", "medium"),
            serviceTier: null,
            disableSummary: false,
            cwd: temp,
            additionalDirectories: [],
        });

        expect(notifications.map(event => event.method)).toEqual([
            "turn/started",
            "thread/compacted",
            "turn/completed",
        ]);

        fs.rmSync(temp, {recursive: true, force: true});
    });

    it("installs a compacted rollout when codex exec treats /compact as a prompt", async () => {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-runtime-test-"));
        const fakeCodex = path.join(temp, "codex");
        const codexHome = path.join(temp, "codex-home");
        const rolloutPath = path.join(
            codexHome,
            "sessions",
            "2026",
            "07",
            "06",
            "rollout-2026-07-06T00-00-00-cli-thread-synthetic-compact.jsonl",
        );
        fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const threadId = "cli-thread-synthetic-compact";
const rolloutPath = ${JSON.stringify(rolloutPath)};
fs.mkdirSync(path.dirname(rolloutPath), {recursive: true});
fs.writeFileSync(rolloutPath, [
  JSON.stringify({type: "session_meta", payload: {session_id: threadId, id: threadId, cwd: process.cwd()}}),
  JSON.stringify({type: "response_item", payload: {type: "message", role: "user", content: [{type: "input_text", text: "Long context before compact " + "x".repeat(40000)}], internal_chat_message_metadata_passthrough: {turn_id: "old-turn"}}}),
  JSON.stringify({type: "event_msg", payload: {type: "token_count", info: {total_token_usage: {input_tokens: 120000, cached_input_tokens: 100000, output_tokens: 1000, reasoning_output_tokens: 200, total_tokens: 121000}, last_token_usage: {input_tokens: 120000, cached_input_tokens: 100000, output_tokens: 1000, reasoning_output_tokens: 200, total_tokens: 121000}, model_context_window: 258400}}}),
  JSON.stringify({type: "response_item", payload: {type: "message", role: "user", content: [{type: "input_text", text: "/compact"}], internal_chat_message_metadata_passthrough: {turn_id: "compact-turn"}}}),
  JSON.stringify({type: "event_msg", payload: {type: "token_count", info: {total_token_usage: {input_tokens: 121258, cached_input_tokens: 4480, output_tokens: 2066, reasoning_output_tokens: 0, total_tokens: 123324}, last_token_usage: {input_tokens: 121258, cached_input_tokens: 4480, output_tokens: 2066, reasoning_output_tokens: 0, total_tokens: 123324}, model_context_window: 258400}}}),
].join("\\n") + "\\n");
console.log(JSON.stringify({type: "thread.started", thread_id: threadId}));
console.log(JSON.stringify({type: "turn.started"}));
console.log(JSON.stringify({type: "item.completed", item: {id: "msg-compact", type: "agent_message", text: "当前进展：\\n- summary from codex exec"}}));
console.log(JSON.stringify({type: "turn.completed", usage: {input_tokens: 121258, cached_input_tokens: 4480, output_tokens: 2066, reasoning_output_tokens: 0, total_tokens: 123324}}));
`, "utf8");
        fs.chmodSync(fakeCodex, 0o755);
        vi.stubEnv("CODEX_PATH", fakeCodex);
        vi.stubEnv("CODEX_HOME", codexHome);

        const runtime = new CodexCliRuntime();
        const session = runtime.createSession({cwd: temp, mcpServers: []}, []);
        const notifications: ServerNotification[] = [];
        runtime.onServerNotification(session.sessionId, event => {
            notifications.push(event);
        });

        await runtime.runPrompt({
            request: {
                sessionId: session.sessionId,
                prompt: [{type: "text", text: "/compact"}],
            },
            agentMode: AgentMode.getInitialAgentMode(),
            modelId: ModelId.create("gpt-5", "medium"),
            serviceTier: null,
            disableSummary: false,
            cwd: temp,
            additionalDirectories: [],
        });

        const records = fs.readFileSync(rolloutPath, "utf8")
            .trim()
            .split(/\n/)
            .map(line => JSON.parse(line) as Record<string, any>);
        const compacted = records.find(record => record["type"] === "compacted");
        expect(compacted).toBeTruthy();
        expect(compacted?.["payload"].message).toContain("Another language model started");
        expect(compacted?.["payload"].message).toContain("summary from codex exec");
        expect(compacted?.["payload"].window_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(compacted?.["payload"].first_window_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        expect(
            compacted?.["payload"].replacement_history.some((item: any) =>
                item.role === "user" &&
                item.content?.some((content: any) => content.text === "/compact"),
            ),
        ).toBe(false);
        expect(records.some(record => record["type"] === "event_msg" && record["payload"]?.type === "context_compacted")).toBe(true);

        const tokenCounts = records
            .filter(record => record["type"] === "event_msg" && record["payload"]?.type === "token_count")
            .map(record => record["payload"].info);
        const latestTokenCount = tokenCounts.at(-1);
        expect(latestTokenCount.model_context_window).toBe(258400);
        expect(latestTokenCount.last_token_usage.total_tokens).toBeLessThan(123324);
        expect(notifications.map(event => event.method)).toContain("thread/compacted");
        expect(notifications.some(event =>
            event.method === "thread/tokenUsage/updated" &&
            (event.params as any).tokenUsage.modelContextWindow === 258400 &&
            (event.params as any).tokenUsage.last.totalTokens < 123324,
        )).toBe(true);

        fs.rmSync(temp, {recursive: true, force: true});
    });
});
