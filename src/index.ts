#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChromiumFishBrowser } from "./browser.js";
import { HELP, parseCli, VERSION } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const browser = new ChromiumFishBrowser(parsed.config);
  const server = createServer(browser, parsed.config);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await browser.close();
    await server.close().catch(() => undefined);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`chromiumfish_mcp: ${message}\n`);
  process.exitCode = 1;
});
