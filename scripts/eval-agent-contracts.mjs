import { readFileSync } from "node:fs";

const files = {
  agentLoop: readFileSync("src/agentLoop.ts", "utf8"),
  view: readFileSync("src/view.ts", "utf8"),
  vaultTools: readFileSync("src/vaultTools.ts", "utf8"),
  types: readFileSync("src/types.ts", "utf8")
};

const checks = [
  {
    name: "URL fetch requests require web evidence (web group = web_fetch only, no web_search)",
    pass:
      /groups\.add\("web"\)/.test(files.view) &&
      /hasUrl/.test(files.view) &&
      /web:\s*new Set\(\["web_fetch"\]\)/.test(files.agentLoop) &&
      !/web_search/.test(files.vaultTools)
  },
  {
    name: "Write tools require confirmation before mutation",
    pass:
      /confirmWrite/.test(files.vaultTools) &&
      /await confirmWrite/.test(files.vaultTools) &&
      /用户取消写入|用户取消编辑|用户取消追加|用户取消插入/.test(files.vaultTools)
  },
  {
    name: "Fetch-proxy failure cannot be reported as completed evidence",
    pass:
      /fetch-proxy 未启动/.test(files.agentLoop) &&
      /makeUnfinishedToolAnswer/.test(files.agentLoop) &&
      /hasRequiredEvidence/.test(files.agentLoop)
  },
  {
    name: "Tool traces are persisted with sessions",
    pass:
      /toolRuns\?: DeepSidianToolRun/.test(files.types) &&
      /currentSession\.toolRuns/.test(files.view) &&
      /renderToolHistory/.test(files.view)
  },
  {
    name: "Undo snapshots are persisted and restorable",
    pass:
      /undoSnapshots\?: DeepSidianUndoSnapshot/.test(files.types) &&
      /recordUndo/.test(files.view) &&
      /undoTurnWrites/.test(files.view)
  }
];

const failures = checks.filter((check) => !check.pass);

if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure.name}`);
  }

  process.exit(1);
}

console.log(`Agent contract eval passed (${checks.length} checks).`);
