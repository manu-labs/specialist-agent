// End-to-end demo: import a HAR trace, synthesize skills, then run the agent.
//
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/demo.ts
//
// This exercises the full pipeline: scrubbed HAR → synthesis call →
// wrapper + workflow skills committed to a tenant git repo → agent run.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpecialistAgent, importHar } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const tenantPath = path.resolve(__dirname, "..", "tenants", "demo");
  const harFile = path.resolve(__dirname, "stripe-trace.har");

  const trace = await importHar(harFile, "Bill a new customer for Q2 consulting fees");
  console.log(`Imported HAR trace: ${trace.requests.length} exchanges, intent="${trace.intent}"`);

  const agent = new SpecialistAgent({
    tenant: { id: "demo", workspacePath: tenantPath },
  });

  console.log("\nSynthesizing skills...");
  const result = await agent.learnFromTrace(trace, { skipReplay: false });
  console.log(`  workflow: ${result.workflow}`);
  console.log(`  wrappers: ${result.wrappers.join(", ")}`);
  console.log(`  commit:   ${result.commit.slice(0, 12)}`);
  console.log(`\nTenant workspace: ${tenantPath}`);
  console.log("Inspect with: ls .claude/skills/  &&  git -C tenants/demo log --oneline");

  // The agent run is left as an exercise for the reader — running it
  // requires a STRIPE_API_KEY in the environment because the wrapper
  // will try to hit real Stripe endpoints. To dry-run the prompt path
  // without making external calls, comment out the line below or
  // wire up a mock auth provider.
  if (process.env.RUN_AGENT === "1") {
    console.log("\nRunning agent with prompt...");
    for await (const msg of agent.run(
      "Bill alice@example.com $500 for April consulting (use 30-day net terms)",
    )) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") process.stdout.write(block.text);
        }
      }
    }
    console.log();
  } else {
    console.log("\nSet RUN_AGENT=1 to also exercise agent.run() against the synthesized skills.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
