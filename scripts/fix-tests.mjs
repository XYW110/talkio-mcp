// Temporary script: fix test files for async loadConfig + orchestrator interface changes
import { readFileSync, writeFileSync } from "node:fs";

// Fix config.test.ts: add async to it() callbacks
let c = readFileSync("test/config.test.ts", "utf8");
c = c.replace(/\bit\("([^"]+)", \(\) =>/g, 'it("$1", async () =>');
writeFileSync("test/config.test.ts", c, "utf8");
console.log("config.test.ts: async added to it() callbacks");

// Fix orchestrator.test.ts:
// 1. runConsultation(question, context, experts, resolveAdapter) → runConsultation(question, experts, config, options)
// 2. runDialogue(opts) → runDialogue(opts, config)
// 3. Remove alwaysResolve, add config
let o = readFileSync("test/orchestrator.test.ts", "utf8");

// Replace the runConsultation calls to use new signature
// Old: runConsultation("问题?", undefined, experts, alwaysResolve(adapter))
// New: runConsultation("问题?", experts, makeConfig(adapter))
o = o.replace(/runConsultation\("([^"]*)", undefined, experts, alwaysResolve\(adapter\)\)/g, 
  'runConsultation("$1", experts, makeConfig(adapter))');
o = o.replace(/runConsultation\("([^"]*)", "([^"]*)", experts, alwaysResolve\(adapter\)\)/g,
  'runConsultation("$1", experts, makeConfig(adapter), { context: "$2" })');

// Remove alwaysResolve function
o = o.replace(/\/\*\* resolveAdapter 签名假设：\(expert\) => ProviderAdapter \*\/\nfunction alwaysResolve\(adapter: ProviderAdapter\) \{\n  return \(\) => adapter;\n\}\n\n/, '');

// Add makeConfig helper after makeExpert
o = o.replace(/(} as ExpertConfig;\n\}\n)/, `$1
/** Build a minimal AppConfig whose resolveProvider always returns the stub adapter. */
function makeConfig(adapter: ProviderAdapter) {
  return {
    providers: {
      openai: { type: "openai" as const, baseUrl: "", apiKeyEnv: "TEST_KEY" },
    },
    experts: [],
  } as unknown as import("../src/config.js").AppConfig;
}
`);

// Fix runDialogue calls to include config parameter
// Old: runDialogue({ topic, experts, mode: "...", rounds: N, summarize: bool })
// New: runDialogue({ topic, experts, mode: "...", rounds: N, summarize: bool }, makeConfig(adapter))
o = o.replace(/await runDialogue\(\{([^}]+)\}\)/g, 'await runDialogue({$1}, makeConfig(adapter))');
o = o.replace(/const \{ turns \} = await runDialogue\(\{([^}]+)\}\)/g, 'const { turns } = await runDialogue({$1}, makeConfig(adapter))');
o = o.replace(/const withSummary = await runDialogue\(\{([^}]+)\}\)/g, 'const withSummary = await runDialogue({$1}, makeConfig(adapter))');
o = o.replace(/const withoutSummary = await runDialogue\(\{([^}]+)\}\)/g, 'const withoutSummary = await runDialogue({$1}, makeConfig(adapter))');

writeFileSync("test/orchestrator.test.ts", o, "utf8");
console.log("orchestrator.test.ts: interface calls updated");

console.log("done");
