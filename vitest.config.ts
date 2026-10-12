import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: process.env.IDCODER_LIVE ? [] : ["test/live/**"],
		environment: "node",
		testTimeout: 20_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "extensions/**/*.ts"],
			exclude: ["src/**/*.md"],
			thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
		},
	},
});
