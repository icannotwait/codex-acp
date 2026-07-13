import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
}

export type CodexLaunch = {
    command: string;
    args: string[];
    shell: boolean;
};

export function nodeExecutableForJavaScriptEntrypoint(
    runtimeIsBun = typeof (process.versions as {bun?: unknown}).bun === "string",
    nodePath = process.execPath,
): string {
    // A compiled Bun sidecar reports itself as process.execPath. Codex's npm
    // entrypoint is supported by Node, so use the host Node command instead.
    return runtimeIsBun ? "node" : nodePath;
}

function isJavaScriptEntrypoint(codexPath: string): boolean {
    return /\.(?:[cm]?js)$/i.test(codexPath);
}

export function resolveCodexCommandLaunch(
    codexPath: string,
    args: string[],
    isWindows = process.platform === "win32",
    nodePath = nodeExecutableForJavaScriptEntrypoint(),
): CodexLaunch {
    if (isWindows && isJavaScriptEntrypoint(codexPath)) {
        return {
            command: nodePath,
            args: [codexPath, ...args],
            shell: false,
        };
    }

    return {
        command: codexPath,
        args,
        shell: false,
    };
}

/**
 * Node's Windows shell cannot reliably launch the npm package's `codex.js`
 * entrypoint directly. Run JavaScript entrypoints through Node explicitly,
 * while retaining shell launch for .cmd/.exe Codex shims.
 */
export function resolveCodexLaunch(
    codexPath: string,
    isWindows = process.platform === "win32",
    nodePath = nodeExecutableForJavaScriptEntrypoint(),
): CodexLaunch {
    if (isWindows && !isJavaScriptEntrypoint(codexPath)) {
        return {
            command: `"${codexPath}" app-server`,
            args: [],
            shell: true,
        };
    }

    return resolveCodexCommandLaunch(codexPath, ["app-server"], isWindows, nodePath);
}

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv): CodexConnection {
    const spawnEnv = env ?? process.env;

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        const launch = resolveCodexLaunch(codexPath);
        codex = spawn(launch.command, launch.args, {
            shell: launch.shell,
            env: spawnEnv,
        });
    } else {
        const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, 'app-server'], {env: spawnEnv});
    }

    attachLogs(codex);

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // Terminate all current activities on process termination
    codex.on("exit", _ => {
        connection.dispose();
    });

    return {connection: connection, process: codex};
}

function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
