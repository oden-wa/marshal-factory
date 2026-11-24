import { initializeSessionLabelState } from "../runner/agentsview-labels";

const [url, ...extra] = process.argv.slice(2);
if (!url || extra.length) {
  console.error("Usage: bun scripts/init-agentsview-labels.ts <AgentsView URL>");
  process.exitCode = 1;
} else {
  try {
    const path = initializeSessionLabelState(url);
    console.log(`Created ${path}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
