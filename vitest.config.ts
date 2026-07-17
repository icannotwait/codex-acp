import {defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        // Isolate CODEX_HOME so CLI session map I/O never touches ~/.codex.
        setupFiles: ["./src/__tests__/setup-codex-home.ts"],
    },
});
