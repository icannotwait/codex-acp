import * as acp from "@agentclientprotocol/sdk";
import {spawn, type ChildProcess} from "node:child_process";
import crypto from "node:crypto";
import fs, {type Dirent} from "node:fs";
import os from "node:os";
import path from "node:path";
import {logger} from "./Logger";
import type {ServerNotification, ServiceTier} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {
    Model,
    Thread,
    ThreadItem,
    TokenUsageBreakdown,
    Turn,
    TurnCompletedNotification,
} from "./app-server/v2";
import {AgentMode} from "./AgentMode";
import {resolveCodexCommandLaunch} from "./CodexJsonRpcConnection";
import {ModelId} from "./ModelId";

type NotificationHandler = (event: ServerNotification) => void | Promise<void>;

interface CliSession {
    sessionId: string;
    cliThreadId: string | null;
    cliRolloutPath: string | null;
    cwd: string;
    additionalDirectories: string[];
    mcpServers: acp.McpServer[];
    activeChild: ChildProcess | null;
    lastPrompt: string | null;
    updatedAt: number;
    lastKnownCompactionCount: number;
    selectedModelId: string | null;
}

interface PersistedCliSession {
    sessionId: string;
    cliThreadId: string;
    cliRolloutPath: string | null;
    cwd: string;
    lastPrompt: string | null;
    updatedAt: number;
    selectedModelId?: string | null;
}

interface CliRunState {
    session: CliSession;
    turnId: string;
    startedAt: number;
    items: ThreadItem[];
    completed: TurnCompletedNotification | null;
    compactionCountBefore: number;
    isCompactPrompt: boolean;
}

type CliJsonEvent = {
    type: string;
    thread_id?: string;
    item?: Record<string, unknown>;
    usage?: Record<string, unknown>;
};

type RolloutTokenUsage = {
    last: TokenUsageBreakdown;
    total: TokenUsageBreakdown;
    modelContextWindow: number | null;
};

type RolloutUserMessage = {
    text: string;
    internalChatMessageMetadataPassthrough: unknown;
};

const CLI_RUNTIME_ENV_VAR = "CODEX_ACP_USE_CLI";
const DEFAULT_CLI_MODEL = "gpt-5";
const CLI_SESSION_MAP_FILENAME = "codeg-codex-acp-cli-sessions.json";
export const LEGACY_CLI_SESSION_MESSAGE =
    "This Codex session was created by the legacy CLI runtime and cannot be resumed. Create a new session.";
const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
const COMPACT_USER_MESSAGE_MAX_ESTIMATED_TOKENS = 20_000;

export function shouldUseCodexCliRuntime(): boolean {
    return process.env[CLI_RUNTIME_ENV_VAR] === "1";
}

export class CodexCliRuntime {
    private readonly sessions = new Map<string, CliSession>();
    private readonly handlers = new Map<string, NotificationHandler>();

    createSession(request: acp.NewSessionRequest, additionalDirectories: string[]): CliSession {
        const sessionId = crypto.randomUUID();
        const session: CliSession = {
            sessionId,
            cliThreadId: null,
            cliRolloutPath: null,
            cwd: request.cwd,
            additionalDirectories,
            mcpServers: request.mcpServers ?? [],
            activeChild: null,
            lastPrompt: null,
            updatedAt: Date.now(),
            lastKnownCompactionCount: 0,
            selectedModelId: null,
        };
        this.sessions.set(sessionId, session);
        return session;
    }

    resumeSession(request: acp.ResumeSessionRequest, additionalDirectories: string[]): CliSession {
        const persisted = readPersistedCliSession(request.sessionId);
        const cliThreadId = persisted?.cliThreadId ?? request.sessionId;
        const cliRolloutPath = persisted?.cliRolloutPath ?? findCodexRolloutPath(cliThreadId);
        const session: CliSession = {
            sessionId: request.sessionId,
            cliThreadId,
            cliRolloutPath,
            cwd: request.cwd || persisted?.cwd || process.cwd(),
            additionalDirectories,
            mcpServers: request.mcpServers ?? [],
            activeChild: null,
            lastPrompt: persisted?.lastPrompt ?? null,
            updatedAt: persisted?.updatedAt ?? Date.now(),
            lastKnownCompactionCount: cliRolloutPath ? countCodexCompactions(cliRolloutPath) : 0,
            selectedModelId: persisted?.selectedModelId ?? null,
        };
        this.sessions.set(request.sessionId, session);
        return session;
    }

    getSession(sessionId: string): CliSession | undefined {
        return this.sessions.get(sessionId);
    }

    selectedModelId(sessionId: string): string | null {
        return this.sessions.get(sessionId)?.selectedModelId ?? null;
    }

    closeSession(sessionId: string): void {
        this.abortSession(sessionId);
        this.handlers.delete(sessionId);
        this.sessions.delete(sessionId);
    }

    abortSession(sessionId: string): void {
        const child = this.sessions.get(sessionId)?.activeChild;
        if (child && !child.killed) {
            child.kill("SIGINT");
            setTimeout(() => {
                if (!child.killed) {
                    child.kill("SIGTERM");
                }
            }, 1_000).unref();
        }
    }

    onServerNotification(sessionId: string, handler: NotificationHandler): void {
        this.handlers.set(sessionId, handler);
    }

    listSessions(cwd?: string | null): acp.ListSessionsResponse {
        const sessions = Array.from(this.sessions.values())
            .filter(session => !cwd || session.cwd === cwd || path.basename(session.cwd) === path.basename(cwd))
            .map(session => ({
                sessionId: session.sessionId,
                cwd: session.cwd,
                title: session.lastPrompt ?? "Codex CLI session",
                updatedAt: new Date(session.updatedAt).toISOString(),
            }));
        return {sessions, nextCursor: null};
    }

    async runPrompt(params: {
        request: acp.PromptRequest;
        agentMode: AgentMode;
        modelId: ModelId;
        serviceTier: ServiceTier | null;
        disableSummary: boolean;
        cwd: string;
        additionalDirectories: string[];
        shouldCancel?: () => boolean;
        onTurnStarted?: (turnId: string) => void;
    }): Promise<TurnCompletedNotification | null> {
        const session = this.sessions.get(params.request.sessionId);
        if (!session) {
            throw new Error(`Unknown Codex CLI session ${params.request.sessionId}`);
        }
        session.selectedModelId = params.modelId.toString();
        if (session.cliThreadId) {
            this.refreshAndPersistSession(session);
        }
        session.cwd = params.cwd;
        session.additionalDirectories = params.additionalDirectories;
        const prompt = promptText(params.request.prompt);
        session.lastPrompt = prompt.slice(0, 160);
        session.updatedAt = Date.now();
        const isCompactPrompt = prompt.trim() === "/compact";

        const turnId = crypto.randomUUID();
        const state: CliRunState = {
            session,
            turnId,
            startedAt: Date.now(),
            items: [],
            completed: null,
            compactionCountBefore: session.lastKnownCompactionCount,
            isCompactPrompt,
        };
        this.emit(session.sessionId, {
            method: "turn/started",
            params: {
                threadId: session.sessionId,
                turn: createTurn(turnId, "inProgress", [], state.startedAt),
            },
        } as ServerNotification);
        params.onTurnStarted?.(turnId);

        const args = buildCodexExecArgs({
            session,
            prompt,
            modelId: params.modelId,
            agentMode: params.agentMode,
            serviceTier: params.serviceTier,
            disableSummary: params.disableSummary,
        });
        logger.log("Starting Codex CLI runtime turn", {
            sessionId: session.sessionId,
            cliThreadId: session.cliThreadId,
            argv: ["codex", ...redactArgs(args)],
        });

        const launch = resolveCodexCommandLaunch(resolveCodexPath(), args);
        const child = spawn(launch.command, launch.args, {
            cwd: session.cwd,
            env: process.env,
            shell: launch.shell,
            stdio: ["ignore", "pipe", "pipe"],
        });
        session.activeChild = child;

        const cancelTimer = setInterval(() => {
            if (params.shouldCancel?.()) {
                this.abortSession(session.sessionId);
            }
        }, 200);
        cancelTimer.unref();

        try {
        if (!child.stdout || !child.stderr) {
            throw new Error("codex exec did not expose stdout/stderr pipes");
        }

        await Promise.all([
            this.consumeJsonl(child.stdout, line => this.handleCliEvent(line, state)),
            this.consumeJsonl(child.stderr, line => this.handleCliDiagnostic(line, state)),
            waitForExit(child),
            ]);
        } finally {
            clearInterval(cancelTimer);
            if (session.activeChild === child) {
                session.activeChild = null;
            }
            session.updatedAt = Date.now();
            this.refreshAndPersistSession(session);
        }

        if (params.shouldCancel?.()) {
            return {
                threadId: session.sessionId,
                turn: createTurn(turnId, "interrupted", state.items, state.startedAt),
            };
        }

        const completed = state.completed ?? {
            threadId: session.sessionId,
            turn: createTurn(turnId, "completed", state.items, state.startedAt),
        };
        const syntheticCompactUsage = this.installCliCompactionIfNeeded(state);
        this.emitNewCompactions(state);
        if (syntheticCompactUsage) {
            this.emitTokenUsageUpdated(state, syntheticCompactUsage);
        }
        this.emit(session.sessionId, {
            method: "turn/completed",
            params: completed,
        } as ServerNotification);
        return completed;
    }

    availableModels(): Model[] {
        return [createVirtualModel(advertisedCliModel())];
    }

    threadForSession(sessionId: string): Thread {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Unknown Codex CLI session ${sessionId}`);
        }
        this.refreshAndPersistSession(session);
        const nowSeconds = Math.floor(session.updatedAt / 1000);
        return {
            id: session.sessionId,
            sessionId: session.sessionId,
            forkedFromId: null,
            parentThreadId: null,
            preview: session.lastPrompt ?? "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: nowSeconds,
            updatedAt: nowSeconds,
            recencyAt: nowSeconds,
            status: {type: "idle"},
            path: session.cliRolloutPath,
            cwd: session.cwd,
            cliVersion: "codex-cli",
            source: "exec",
            threadSource: "exec",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: session.lastPrompt,
            turns: [],
        };
    }

    private async consumeJsonl(
        stream: NodeJS.ReadableStream,
        onJsonLine: (line: string) => void | Promise<void>,
    ): Promise<void> {
        let buffer = "";
        for await (const chunk of stream) {
            buffer += chunk.toString("utf8");
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("{")) {
                    continue;
                }
                await onJsonLine(trimmed);
            }
        }
        const trimmed = buffer.trim();
        if (trimmed.startsWith("{")) {
            await onJsonLine(trimmed);
        }
    }

    private handleCliDiagnostic(line: string, state: CliRunState): void {
        try {
            this.handleCliEvent(line, state);
        } catch {
            logger.log("Codex CLI diagnostic", {sessionId: state.session.sessionId, line});
        }
    }

    private handleCliEvent(line: string, state: CliRunState): void {
        let event: CliJsonEvent;
        try {
            event = JSON.parse(line) as CliJsonEvent;
        } catch {
            logger.log("Ignoring non-JSON Codex CLI output", {line});
            return;
        }
        switch (event.type) {
            case "thread.started":
                if (typeof event.thread_id === "string" && event.thread_id.length > 0) {
                    state.session.cliThreadId = event.thread_id;
                    this.refreshAndPersistSession(state.session);
                }
                return;
            case "turn.started":
                return;
            case "item.started":
                this.handleCliItem(event.item, state, false);
                return;
            case "item.completed":
                this.handleCliItem(event.item, state, true);
                return;
            case "turn.completed":
                this.handleCliTurnCompleted(event, state);
                return;
            default:
                logger.log("Ignoring unsupported Codex CLI event", {
                    sessionId: state.session.sessionId,
                    type: event.type,
                });
        }
    }

    private handleCliItem(rawItem: Record<string, unknown> | undefined, state: CliRunState, completed: boolean): void {
        const item = this.convertCliItem(rawItem, state, completed);
        if (!item) {
            return;
        }
        const existingIndex = state.items.findIndex(existing => existing.id === item.id);
        if (existingIndex >= 0) {
            state.items[existingIndex] = item;
        } else {
            state.items.push(item);
        }

        if (item.type === "agentMessage") {
            if (item.text.length > 0) {
                this.emit(state.session.sessionId, {
                    method: "item/agentMessage/delta",
                    params: {
                        threadId: state.session.sessionId,
                        turnId: state.turnId,
                        itemId: item.id,
                        delta: item.text,
                    },
                } as ServerNotification);
            }
            return;
        }

        this.emit(state.session.sessionId, {
            method: completed ? "item/completed" : "item/started",
            params: {
                threadId: state.session.sessionId,
                turnId: state.turnId,
                item,
                [completed ? "completedAtMs" : "startedAtMs"]: Date.now(),
            },
        } as ServerNotification);
    }

    private convertCliItem(
        rawItem: Record<string, unknown> | undefined,
        state: CliRunState,
        completed: boolean,
    ): ThreadItem | null {
        if (!rawItem) {
            return null;
        }
        const id = stringValue(rawItem["id"]) ?? crypto.randomUUID();
        const status = completed ? "completed" : "inProgress";
        switch (rawItem["type"]) {
            case "agent_message":
                return {
                    type: "agentMessage",
                    id,
                    text: stringValue(rawItem["text"]) ?? "",
                    phase: null,
                    memoryCitation: null,
                };
            case "command_execution":
                return {
                    type: "commandExecution",
                    id,
                    command: stringValue(rawItem["command"]) ?? "",
                    cwd: state.session.cwd,
                    processId: null,
                    source: "agent",
                    status: cliStatus(rawItem["status"], status),
                    commandActions: [],
                    aggregatedOutput: stringValue(rawItem["aggregated_output"]) ?? null,
                    exitCode: numberValue(rawItem["exit_code"]),
                    durationMs: numberValue(rawItem["duration_ms"]),
                };
            case "mcp_tool_call":
                return {
                    type: "mcpToolCall",
                    id,
                    server: stringValue(rawItem["server"]) ?? stringValue(rawItem["server_name"]) ?? "mcp",
                    tool: stringValue(rawItem["tool"]) ?? stringValue(rawItem["tool_name"]) ?? "tool",
                    status: cliStatus(rawItem["status"], status),
                    arguments: jsonValue(rawItem["arguments"] ?? rawItem["input"]),
                    appContext: null,
                    pluginId: null,
                    result: mcpResultValue(rawItem["result"]),
                    error: mcpErrorValue(rawItem["error"]),
                    durationMs: numberValue(rawItem["duration_ms"]),
                };
            case "function_call":
            case "custom_tool_call":
                return {
                    type: "dynamicToolCall",
                    id,
                    namespace: null,
                    tool: stringValue(rawItem["name"]) ?? "tool",
                    arguments: jsonValue(rawItem["arguments"] ?? rawItem["input"]),
                    status: cliStatus(rawItem["status"], status),
                    contentItems: null,
                    success: completed ? true : null,
                    durationMs: numberValue(rawItem["duration_ms"]),
                };
            default:
                return null;
        }
    }

    private handleCliTurnCompleted(event: CliJsonEvent, state: CliRunState): void {
        const usage = usageBreakdown(event.usage);
        if (usage) {
            this.emit(state.session.sessionId, {
                method: "thread/tokenUsage/updated",
                params: {
                    threadId: state.session.sessionId,
                    turnId: state.turnId,
                    tokenUsage: {
                        last: usage,
                        total: usage,
                        modelContextWindow: null,
                    },
                },
            } as ServerNotification);
        }
        state.completed = {
            threadId: state.session.sessionId,
            turn: createTurn(state.turnId, "completed", state.items, state.startedAt),
        };
    }

    private emit(sessionId: string, event: ServerNotification): void {
        const handler = this.handlers.get(sessionId);
        if (handler) {
            void handler(event);
        }
    }

    private refreshAndPersistSession(session: CliSession): void {
        if (!session.cliThreadId) {
            return;
        }
        this.refreshSessionRolloutPath(session);
        ensureCodegSessionAlias(session);
        persistCliSession(session);
    }

    private refreshSessionRolloutPath(session: CliSession): void {
        if (!session.cliThreadId) {
            return;
        }
        session.cliRolloutPath = findCodexRolloutPath(session.cliThreadId) ?? session.cliRolloutPath;
    }

    private emitNewCompactions(state: CliRunState): void {
        this.refreshSessionRolloutPath(state.session);
        const compactionCountAfter = state.session.cliRolloutPath
            ? countCodexCompactions(state.session.cliRolloutPath)
            : state.compactionCountBefore;
        state.session.lastKnownCompactionCount = compactionCountAfter;
        const newCompactions = compactionCountAfter - state.compactionCountBefore;
        if (newCompactions <= 0) {
            return;
        }
        for (let index = 0; index < newCompactions; index += 1) {
            this.emit(state.session.sessionId, {
                method: "thread/compacted",
                params: {
                    threadId: state.session.sessionId,
                    turnId: index === 0 ? state.turnId : crypto.randomUUID(),
                },
            } as ServerNotification);
        }
    }

    private installCliCompactionIfNeeded(state: CliRunState): RolloutTokenUsage | null {
        if (!state.isCompactPrompt) {
            return null;
        }

        this.refreshSessionRolloutPath(state.session);
        const rolloutPath = state.session.cliRolloutPath;
        if (!rolloutPath) {
            logger.log("Cannot install Codex CLI compacted rollout without rollout path", {
                sessionId: state.session.sessionId,
                cliThreadId: state.session.cliThreadId,
            });
            return null;
        }

        if (countCodexCompactions(rolloutPath) > state.compactionCountBefore) {
            return latestCodexTokenUsage(rolloutPath);
        }

        const summary = compactSummaryFromTurn(state);
        if (!summary) {
            logger.log("Cannot install Codex CLI compacted rollout without compact summary", {
                sessionId: state.session.sessionId,
                rolloutPath,
            });
            return null;
        }

        return appendSyntheticCompaction(rolloutPath, summary);
    }

    private emitTokenUsageUpdated(state: CliRunState, usage: RolloutTokenUsage): void {
        this.emit(state.session.sessionId, {
            method: "thread/tokenUsage/updated",
            params: {
                threadId: state.session.sessionId,
                turnId: state.turnId,
                tokenUsage: usage,
            },
        } as ServerNotification);
    }
}

export function codexExecModelArgs(modelId: ModelId): string[] {
    return [
        "-m",
        runtimeCliModel(modelId.model),
        "-c",
        `model_reasoning_effort=${tomlString(modelId.effort)}`,
    ];
}

function buildCodexExecArgs(params: {
    session: CliSession;
    prompt: string;
    modelId: ModelId;
    agentMode: AgentMode;
    serviceTier: ServiceTier | null;
    disableSummary: boolean;
}): string[] {
    const args: string[] = [];
    const isResume = params.session.cliThreadId !== null;
    args.push("exec");
    args.push("--json", "--skip-git-repo-check", "-C", params.session.cwd);
    args.push(...codexExecModelArgs(params.modelId));
    args.push("-s", codexSandboxArg(params.agentMode));
    if (params.disableSummary) {
        args.push("-c", "model_reasoning_summary=\"none\"");
    }
    if (params.serviceTier) {
        args.push("-c", `service_tier=${tomlString(params.serviceTier)}`);
    }
    for (const root of params.session.additionalDirectories) {
        args.push("--add-dir", root);
    }
    args.push(...mcpServerConfigArgs(params.session.mcpServers));
    if (isResume) {
        args.push("resume", params.session.cliThreadId!);
    }
    args.push(params.prompt.length > 0 ? params.prompt : " ");
    return args;
}

export function mcpServerConfigArgs(mcpServers: acp.McpServer[]): string[] {
    const args: string[] = [];
    for (const server of mcpServers) {
        const name = sanitizeMcpName(server.name);
        if ("type" in server) {
            if (server.type === "http") {
                args.push("-c", `mcp_servers.${name}.url=${tomlString(server.url)}`);
                if (server.headers.length > 0) {
                    args.push("-c", `mcp_servers.${name}.http_headers=${tomlInlineTable(Object.fromEntries(server.headers.map(header => [header.name, header.value])))}`);
                }
            }
            continue;
        }
        args.push("-c", `mcp_servers.${name}.command=${tomlString(server.command)}`);
        if (server.args.length > 0) {
            args.push("-c", `mcp_servers.${name}.args=${tomlArray(server.args)}`);
        }
        if (server.env.length > 0) {
            args.push("-c", `mcp_servers.${name}.env=${tomlInlineTable(Object.fromEntries(server.env.map(env => [env.name, env.value])))}`);
        }
    }
    return args;
}

function promptText(prompt: acp.ContentBlock[]): string {
    return prompt.map(block => {
        switch (block.type) {
            case "text":
                return block.text;
            case "resource_link":
                return block.name ? `[@${block.name}](${block.uri})` : block.uri;
            case "resource":
                if ("text" in block.resource) {
                    return `<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>`;
                }
                return `<context ref="${block.resource.uri}" mimeType="${block.resource.mimeType ?? "application/octet-stream"}" encoding="base64">\n${block.resource.blob}\n</context>`;
            case "image":
                return `[image: ${block.uri ?? `${block.mimeType};base64,${block.data.slice(0, 32)}...`}]`;
            case "audio":
                return "";
        }
    }).filter(part => part.length > 0).join("\n\n");
}

function createTurn(id: string, status: Turn["status"], items: ThreadItem[], startedAtMs: number): Turn {
    const completedAt = status === "inProgress" ? null : Math.floor(Date.now() / 1000);
    return {
        id,
        items,
        itemsView: "full",
        status,
        error: null,
        startedAt: Math.floor(startedAtMs / 1000),
        completedAt,
        durationMs: completedAt === null ? null : Date.now() - startedAtMs,
    };
}

function createVirtualModel(id: string): Model {
    return {
        id,
        model: id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: id,
        description: "Codex CLI model",
        hidden: false,
        supportedReasoningEfforts: [
            {reasoningEffort: "low", description: "Low"},
            {reasoningEffort: "medium", description: "Medium"},
            {reasoningEffort: "high", description: "High"},
            {reasoningEffort: "xhigh", description: "Extra high"},
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
    };
}

function codexSandboxArg(agentMode: AgentMode): string {
    switch (agentMode.sandboxPolicy.type) {
        case "readOnly":
            return "read-only";
        case "dangerFullAccess":
            return "danger-full-access";
        case "workspaceWrite":
            return "workspace-write";
        case "externalSandbox":
            return "workspace-write";
    }
}

function resolveCodexPath(): string {
    return process.env["CODEX_PATH"]?.trim() || "codex";
}

function advertisedCliModel(): string {
    return process.env["CODEX_ACP_CLI_MODEL"]?.trim() || DEFAULT_CLI_MODEL;
}

function runtimeCliModel(requestedModel: string): string {
    return process.env["CODEX_ACP_CLI_MODEL"]?.trim() || requestedModel;
}

function codexHome(): string {
    return process.env["CODEX_HOME"]?.trim() || path.join(os.homedir(), ".codex");
}

function cliSessionMapPath(): string {
    return path.join(codexHome(), CLI_SESSION_MAP_FILENAME);
}

function readPersistedCliSessions(): Record<string, PersistedCliSession> {
    try {
        const parsed = JSON.parse(fs.readFileSync(cliSessionMapPath(), "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        const sessions: Record<string, PersistedCliSession> = {};
        for (const [key, value] of Object.entries(parsed)) {
            const record = value && typeof value === "object" && !Array.isArray(value)
                ? value as Record<string, unknown>
                : null;
            const sessionId = record ? stringValue(record["sessionId"]) : null;
            const cliThreadId = record ? stringValue(record["cliThreadId"]) : null;
            if (!sessionId || !cliThreadId) {
                continue;
            }
            sessions[key] = {
                sessionId,
                cliThreadId,
                cliRolloutPath: record ? stringValue(record["cliRolloutPath"]) : null,
                cwd: record ? stringValue(record["cwd"]) ?? process.cwd() : process.cwd(),
                lastPrompt: record ? stringValue(record["lastPrompt"]) : null,
                updatedAt: record ? numberValue(record["updatedAt"]) ?? Date.now() : Date.now(),
                selectedModelId: record ? stringValue(record["selectedModelId"]) : null,
            };
        }
        return sessions;
    } catch {
        return {};
    }
}

function readPersistedCliSession(sessionId: string): PersistedCliSession | null {
    return readPersistedCliSessions()[sessionId] ?? null;
}

export function isPersistedCliRuntimeSession(sessionId: string): boolean {
    return readPersistedCliSession(sessionId) !== null;
}

function persistCliSession(session: CliSession): void {
    if (!session.cliThreadId) {
        return;
    }

    const sessions = readPersistedCliSessions();
    sessions[session.sessionId] = {
        sessionId: session.sessionId,
        cliThreadId: session.cliThreadId,
        cliRolloutPath: session.cliRolloutPath,
        cwd: session.cwd,
        lastPrompt: session.lastPrompt,
        updatedAt: session.updatedAt,
        selectedModelId: session.selectedModelId,
    };
    try {
        fs.mkdirSync(codexHome(), {recursive: true});
        fs.writeFileSync(cliSessionMapPath(), `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
    } catch (error) {
        logger.log("Failed to persist Codex CLI session mapping", {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function ensureCodegSessionAlias(session: CliSession): void {
    if (!session.cliRolloutPath || session.sessionId === session.cliThreadId) {
        return;
    }

    const aliasPath = codegSessionAliasPath(session.cliRolloutPath, session.sessionId);
    try {
        if (!fs.existsSync(session.cliRolloutPath)) {
            return;
        }
        if (fs.existsSync(aliasPath)) {
            const target = fs.statSync(session.cliRolloutPath);
            const alias = fs.statSync(aliasPath);
            if (target.dev === alias.dev && target.ino === alias.ino) {
                return;
            }
            fs.unlinkSync(aliasPath);
        }
        fs.linkSync(session.cliRolloutPath, aliasPath);
    } catch (error) {
        logger.log("Failed to create Codeg Codex CLI session alias", {
            sessionId: session.sessionId,
            cliThreadId: session.cliThreadId,
            rolloutPath: session.cliRolloutPath,
            aliasPath,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function codegSessionAliasPath(rolloutPath: string, sessionId: string): string {
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(path.dirname(rolloutPath), `codeg-acp-session-${safeSessionId}.jsonl`);
}

function findCodexRolloutPath(sessionId: string): string | null {
    const sessionsDir = path.join(codexHome(), "sessions");
    const suffix = `${sessionId}.jsonl`;
    const stack: string[] = [sessionsDir];

    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
                .sort((a, b) => b.name.localeCompare(a.name));
        } catch {
            continue;
        }

        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
                return entryPath;
            }
            if (entry.isDirectory()) {
                stack.push(entryPath);
            }
        }
    }

    return null;
}

function countCodexCompactions(rolloutPath: string): number {
    let compactedItems = 0;
    let contextCompactedEvents = 0;
    let text: string;
    try {
        text = fs.readFileSync(rolloutPath, "utf8");
    } catch {
        return 0;
    }

    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
            continue;
        }
        let record: Record<string, unknown>;
        try {
            record = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (record["type"] === "compacted") {
            compactedItems += 1;
            continue;
        }
        if (record["type"] !== "event_msg") {
            continue;
        }
        const payload = record["payload"];
        if (
            payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            (payload as Record<string, unknown>)["type"] === "context_compacted"
        ) {
            contextCompactedEvents += 1;
        }
    }

    return compactedItems > 0 ? compactedItems : contextCompactedEvents;
}

function compactSummaryFromTurn(state: CliRunState): string | null {
    for (const item of state.items.slice().reverse()) {
        if (item.type === "agentMessage" && item.text.trim().length > 0) {
            return item.text.trim();
        }
    }
    return null;
}

function appendSyntheticCompaction(rolloutPath: string, summary: string): RolloutTokenUsage | null {
    const latestUsage = latestCodexTokenUsage(rolloutPath);
    const windowState = latestCompactionWindowState(rolloutPath);
    const userMessages = selectRecentUserMessages(collectRolloutUserMessages(rolloutPath));
    const summaryText = summary.startsWith(`${SUMMARY_PREFIX}\n`)
        ? summary
        : `${SUMMARY_PREFIX}\n${summary}`;
    const replacementHistory = [
        ...userMessages.map(userMessageToResponseItem),
        userMessageToResponseItem({
            text: summaryText,
            internalChatMessageMetadataPassthrough: null,
        }),
    ];
    const windowId = uuidV7();
    const firstWindowId = windowState.firstWindowId ?? windowState.windowId ?? uuidV7();
    const compactedPayload = {
        message: summaryText,
        replacement_history: replacementHistory,
        window_number: windowState.windowNumber === null ? 1 : windowState.windowNumber + 1,
        first_window_id: firstWindowId,
        previous_window_id: windowState.windowId,
        window_id: windowId,
    };
    const last = estimateTokenUsageForReplacementHistory(replacementHistory);
    const total = latestUsage?.total ?? last;
    const modelContextWindow = latestUsage?.modelContextWindow ?? null;
    const timestamp = new Date().toISOString();
    const tokenCountInfo = {
        total_token_usage: toSnakeTokenUsage(total),
        last_token_usage: toSnakeTokenUsage(last),
        model_context_window: modelContextWindow,
    };

    try {
        fs.appendFileSync(rolloutPath, [
            JSON.stringify({timestamp, type: "compacted", payload: compactedPayload}),
            JSON.stringify({timestamp, type: "event_msg", payload: {type: "context_compacted"}}),
            JSON.stringify({timestamp, type: "event_msg", payload: {type: "token_count", info: tokenCountInfo}}),
        ].join("\n") + "\n", "utf8");
    } catch (error) {
        logger.log("Failed to append synthetic Codex CLI compacted rollout", {
            rolloutPath,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }

    return {last, total, modelContextWindow};
}

function uuidV7(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const timestamp = Date.now();

    bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
    bytes[5] = timestamp & 0xff;
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    return Buffer.from(bytes).toString("hex").replace(
        /(.{8})(.{4})(.{4})(.{4})(.{12})/,
        "$1-$2-$3-$4-$5",
    );
}

function latestCodexTokenUsage(rolloutPath: string): RolloutTokenUsage | null {
    let latest: RolloutTokenUsage | null = null;
    let modelContextWindow: number | null = null;

    for (const record of readRolloutRecords(rolloutPath)) {
        if (record["type"] !== "event_msg") {
            continue;
        }
        const payload = objectValue(record["payload"]);
        if (!payload) {
            continue;
        }
        if (payload["type"] === "task_started") {
            modelContextWindow = numberValue(payload["model_context_window"]) ?? modelContextWindow;
            continue;
        }
        if (payload["type"] !== "token_count") {
            continue;
        }
        const info = objectValue(payload["info"]);
        if (!info) {
            continue;
        }
        modelContextWindow = numberValue(info["model_context_window"]) ?? modelContextWindow;
        const last = usageBreakdown(info["last_token_usage"]);
        if (!last) {
            continue;
        }
        latest = {
            last,
            total: usageBreakdown(info["total_token_usage"]) ?? last,
            modelContextWindow,
        };
    }

    return latest;
}

function latestCompactionWindowState(rolloutPath: string): {
    windowNumber: number | null;
    firstWindowId: string | null;
    windowId: string | null;
} {
    let windowNumber: number | null = null;
    let firstWindowId: string | null = null;
    let windowId: string | null = null;

    for (const record of readRolloutRecords(rolloutPath)) {
        if (record["type"] !== "compacted") {
            continue;
        }
        const payload = objectValue(record["payload"]);
        if (!payload) {
            continue;
        }
        windowNumber = numberValue(payload["window_number"]) ?? windowNumber;
        firstWindowId = stringValue(payload["first_window_id"]) ?? firstWindowId;
        windowId = stringValue(payload["window_id"]) ?? windowId;
    }

    return {windowNumber, firstWindowId, windowId};
}

function collectRolloutUserMessages(rolloutPath: string): RolloutUserMessage[] {
    let messages: RolloutUserMessage[] = [];

    for (const record of readRolloutRecords(rolloutPath)) {
        if (record["type"] === "compacted") {
            const payload = objectValue(record["payload"]);
            const replacementHistory = payload?.["replacement_history"];
            if (Array.isArray(replacementHistory)) {
                messages = replacementHistory
                    .map(userMessageFromResponseItem)
                    .filter((message): message is RolloutUserMessage => message !== null);
            }
            continue;
        }

        if (record["type"] !== "response_item") {
            continue;
        }
        const message = userMessageFromResponseItem(record["payload"]);
        if (message) {
            messages.push(message);
        }
    }

    return messages.filter(message => shouldKeepCompactedUserMessage(message.text));
}

function readRolloutRecords(rolloutPath: string): Record<string, unknown>[] {
    let text: string;
    try {
        text = fs.readFileSync(rolloutPath, "utf8");
    } catch {
        return [];
    }

    const records: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
            continue;
        }
        try {
            const record = JSON.parse(trimmed) as unknown;
            if (record && typeof record === "object" && !Array.isArray(record)) {
                records.push(record as Record<string, unknown>);
            }
        } catch {
            continue;
        }
    }
    return records;
}

function userMessageFromResponseItem(value: unknown): RolloutUserMessage | null {
    const item = objectValue(value);
    if (!item || item["type"] !== "message" || item["role"] !== "user") {
        return null;
    }

    const text = contentText(item["content"]).trim();
    if (text.length === 0 || !shouldKeepCompactedUserMessage(text)) {
        return null;
    }

    return {
        text,
        internalChatMessageMetadataPassthrough: item["internal_chat_message_metadata_passthrough"] ?? null,
    };
}

function contentText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (!Array.isArray(value)) {
        return "";
    }
    return value.map(content => {
        const record = objectValue(content);
        if (!record) {
            return "";
        }
        return stringValue(record["text"]) ?? "";
    }).filter(part => part.length > 0).join("\n");
}

function shouldKeepCompactedUserMessage(text: string): boolean {
    const trimmed = text.trim();
    return trimmed !== "/compact" && !trimmed.startsWith(`${SUMMARY_PREFIX}\n`);
}

function selectRecentUserMessages(messages: RolloutUserMessage[]): RolloutUserMessage[] {
    const selected: RolloutUserMessage[] = [];
    let remaining = COMPACT_USER_MESSAGE_MAX_ESTIMATED_TOKENS;

    for (const message of messages.slice().reverse()) {
        if (remaining <= 0) {
            break;
        }
        const tokens = estimateTokens(message.text);
        if (tokens <= remaining) {
            selected.push(message);
            remaining -= tokens;
            continue;
        }
        const maxChars = Math.max(1, remaining * 4);
        selected.push({
            text: message.text.slice(-maxChars),
            internalChatMessageMetadataPassthrough: message.internalChatMessageMetadataPassthrough,
        });
        break;
    }

    return selected.reverse();
}

function userMessageToResponseItem(message: RolloutUserMessage): Record<string, unknown> {
    const item: Record<string, unknown> = {
        type: "message",
        role: "user",
        content: [{type: "input_text", text: message.text}],
    };
    if (message.internalChatMessageMetadataPassthrough !== null) {
        item["internal_chat_message_metadata_passthrough"] = message.internalChatMessageMetadataPassthrough;
    }
    return item;
}

function estimateTokenUsageForReplacementHistory(items: Record<string, unknown>[]): TokenUsageBreakdown {
    const text = items.map(item => contentText(item["content"])).join("\n\n");
    const inputTokens = Math.max(1, estimateTokens(text));
    return {
        totalTokens: inputTokens,
        inputTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
    };
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function toSnakeTokenUsage(usage: TokenUsageBreakdown): Record<string, number> {
    return {
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
        total_tokens: usage.totalTokens,
    };
}

function objectValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function sanitizeMcpName(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
    return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
    return `{${Object.entries(values).map(([key, value]) => `${key}=${tomlString(value)}`).join(", ")}}`;
}

function redactArgs(args: string[]): string[] {
    return args.map(arg => arg.includes("api_key") || arg.includes("TOKEN") ? "<redacted>" : arg);
}

function stringValue(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function jsonValue(value: unknown): JsonValue {
    if (typeof value === "string") {
        try {
            return JSON.parse(value) as JsonValue;
        } catch {
            return value;
        }
    }
    if (value === undefined) {
        return {};
    }
    return value as JsonValue;
}

function mcpResultValue(value: unknown): {content: JsonValue[]; structuredContent: JsonValue | null; _meta: JsonValue | null} | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "object" && !Array.isArray(value) && "content" in value) {
        const record = value as Record<string, unknown>;
        return {
            content: Array.isArray(record["content"]) ? record["content"] as JsonValue[] : [jsonValue(record["content"])],
            structuredContent: jsonValue(record["structuredContent"] ?? record["structured_content"] ?? null),
            _meta: jsonValue(record["_meta"] ?? null),
        };
    }
    return {
        content: [jsonValue(value)],
        structuredContent: null,
        _meta: null,
    };
}

function mcpErrorValue(value: unknown): {message: string} | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "object" && !Array.isArray(value) && "message" in value) {
        const message = stringValue((value as Record<string, unknown>)["message"]);
        return {message: message ?? JSON.stringify(value)};
    }
    return {
        message: typeof value === "string" ? value : JSON.stringify(value),
    };
}

function cliStatus(value: unknown, fallback: "inProgress" | "completed"): "inProgress" | "completed" | "failed" {
    if (value === "in_progress") {
        return "inProgress";
    }
    if (value === "completed") {
        return "completed";
    }
    if (value === "failed") {
        return "failed";
    }
    return fallback;
}

function usageBreakdown(value: unknown): {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
} | null {
    if (!value || typeof value !== "object") {
        return null;
    }
    const record = value as Record<string, unknown>;
    const inputTokens = numberValue(record["input_tokens"]) ?? 0;
    const cachedInputTokens = numberValue(record["cached_input_tokens"]) ?? 0;
    const outputTokens = numberValue(record["output_tokens"]) ?? 0;
    const reasoningOutputTokens = numberValue(record["reasoning_output_tokens"]) ?? 0;
    const totalTokens = numberValue(record["total_tokens"]) ?? inputTokens + outputTokens;
    return {
        totalTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
    };
}

function waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
                resolve();
            } else {
                reject(new Error(`codex exec exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
            }
        });
    });
}

export const CODEX_CLI_RUNTIME_ENV_VAR = CLI_RUNTIME_ENV_VAR;
