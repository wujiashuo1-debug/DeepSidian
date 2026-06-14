import { readFileSync } from "node:fs";

const vaultTools = readFileSync("src/vaultTools.ts", "utf8");
const agentLoop = readFileSync("src/agentLoop.ts", "utf8");

const errors = [];

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);

  if (start === -1) {
    errors.push(`Missing marker: ${startMarker}`);
    return "";
  }

  const end = source.indexOf(endMarker, start);

  if (end === -1) {
    errors.push(`Missing marker after ${startMarker}: ${endMarker}`);
    return "";
  }

  return source.slice(start, end + endMarker.length);
}

function quotedStrings(source) {
  return [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

const definitionsBlock = extractBetween(
  vaultTools,
  "export const VAULT_TOOL_DEFINITIONS",
  "];"
);
const definedTools = new Set([...definitionsBlock.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]));

const dispatchBlock = extractBetween(vaultTools, "switch (name)", "default:");
const dispatchTools = new Set([...dispatchBlock.matchAll(/case\s+"([^"]+)":/g)].map((match) => match[1]));

const readOnlyBlock = extractBetween(vaultTools, "const READ_ONLY_TOOL_NAMES", "];");
const readOnlyTools = new Set(quotedStrings(readOnlyBlock));

const toolsetsBlock = extractBetween(vaultTools, "export const AGENT_TOOLSETS", "};");
const explicitToolsetTools = new Set(
  quotedStrings(toolsetsBlock).filter((value) => value.includes("_"))
);

const toolGroupsBlock = extractBetween(agentLoop, "const TOOL_GROUPS", "};");
const groupedTools = new Set(
  quotedStrings(toolGroupsBlock).filter((value) => value.includes("_") || value === "bash")
);

for (const tool of definedTools) {
  if (!dispatchTools.has(tool)) {
    errors.push(`Tool is defined but not dispatched: ${tool}`);
  }
}

for (const tool of dispatchTools) {
  if (!definedTools.has(tool)) {
    errors.push(`Tool is dispatched but not defined: ${tool}`);
  }
}

for (const tool of readOnlyTools) {
  if (!definedTools.has(tool)) {
    errors.push(`Read-only toolset references unknown tool: ${tool}`);
  }
}

for (const tool of explicitToolsetTools) {
  if (!definedTools.has(tool)) {
    errors.push(`Agent toolset references unknown tool: ${tool}`);
  }
}

for (const tool of groupedTools) {
  if (!definedTools.has(tool)) {
    errors.push(`AgentLoop tool group references unknown tool: ${tool}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Tool registry check passed (${sorted(definedTools).length} tools).`);
