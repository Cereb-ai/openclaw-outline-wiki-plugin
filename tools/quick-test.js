/**
 * Phase 5 quick-test: drive the outline-wiki plugin directly without
 * going through the OpenClaw gateway + permission stack.
 *
 * 0.4.0 update: switched from a single `outline_wiki` dispatcher (called via
 * `{category, method, args}` envelope) to 12 named tools (one per outline
 * category.method). The test now:
 *   - loads `dist/index.js` (default export is the defineToolPlugin entry)
 *   - mocks `api` with `pluginConfig` + `registerTool`
 *   - captures ALL registered tools via registerTool (Map<name, tool>)
 *   - invokes a named tool directly: `tool.execute(toolCallId, params)`
 *     (no envelope parsing needed)
 *
 * Usage:
 *   node tools/quick-test.js outline_doc_list '{"limit":3}'
 *   node tools/quick-test.js outline_search_query '{"query":"redis sentinel"}'
 *   node tools/quick-test.js outline_doc_get '{"id":"<uuid>"}'
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, "..", "dist", "index.js");

// Load the plugin's default export (the defineToolPlugin result).
const mod = await import(distEntry);
const plugin = mod.default;
if (!plugin || typeof plugin.register !== "function") {
  console.error("dist/index.js did not export a plugin entry with register()");
  process.exit(2);
}

// Build a fake `api` matching the subset of the plugin-sdk we use.
const registered = new Map();
const api = {
  pluginConfig: {
    apiToken: readBearerToken(),
    endpoint: "https://wiki.dev.cereb.ai/api",
    mcpEndpoint: "https://wiki.dev.cereb.ai/mcp",
  },
  registerTool(toolOrFactory, opts) {
    // defineToolPlugin registers each tool with `{ name, label, description,
    // parameters, execute }`. We don't need to honour the factory variant
    // because the outline plugin uses plain execute functions.
    if (typeof toolOrFactory === "function") {
      // factory: skip (no outline tool uses it today; if one does in the
      // future we'll need a context-aware invocation harness).
      console.error("[quick-test] WARN: tool factory detected; quick-test does not invoke factories.");
      return;
    }
    registered.set(toolOrFactory.name, toolOrFactory);
  },
};

plugin.register(api);

if (registered.size === 0) {
  console.error("plugin.register did not call api.registerTool");
  process.exit(2);
}

console.log(`[quick-test] plugin loaded: ${registered.size} tools registered`);
for (const [name, tool] of registered) {
  console.log(`  - ${name} (label=${tool.label})`);
}
console.log();

const toolName = process.argv[2];
const argsStr = process.argv[3] ?? "{}";

if (!toolName) {
  console.error("Usage: node tools/quick-test.js <tool_name> '[args-json]'");
  console.error("Example: node tools/quick-test.js outline_doc_list '{\"limit\":3}'");
  console.error();
  console.error("Available tools:");
  for (const name of registered.keys()) console.error(`  ${name}`);
  process.exit(2);
}

const tool = registered.get(toolName);
if (!tool) {
  console.error(`[quick-test] tool "${toolName}" is not registered by this plugin.`);
  console.error("Available tools:", [...registered.keys()].join(", "));
  process.exit(2);
}

let args;
try {
  args = JSON.parse(argsStr);
} catch (err) {
  console.error(`could not parse args JSON: ${err.message}`);
  process.exit(2);
}

console.log(`[quick-test] invoking: ${toolName} ${argsStr}`);
const result = await tool.execute("test-call-id", args, undefined);
const text = result?.content?.[0]?.text ?? "<no text>";
console.log("[quick-test] result.text (first 800 chars):");
console.log(text.slice(0, 800));
if (text.length > 800) console.log("…(truncated)");
console.log();
console.log(`[quick-test] result.details keys: ${Object.keys(result?.details ?? {}).join(", ")}`);

function readBearerToken() {
  const mc = JSON.parse(
    readFileSync(
      resolve(
        process.env.HOME,
        ".openclaw",
        "workspace",
        "config",
        "mcporter.json",
      ),
      "utf8",
    ),
  );
  const auth = mc?.mcpServers?.outline?.headers?.Authorization ?? "";
  return auth.replace(/^Bearer\s+/, "");
}