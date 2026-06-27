#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { displayPath, parseArgs, required } from "./common.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const runVerifyJson = (args) =>
  new Promise((resolve) => {
    const verifyArgs = ["--json"];
    for (const [key, value] of Object.entries(args)) {
      if (key === "_" || key === "json") continue;
      if (value === true) verifyArgs.push(`--${key}`);
      else if (value) verifyArgs.push(`--${key}`, String(value));
    }
    const child = spawn(process.execPath, [
      join(scriptDir, "verify.mjs"),
      ...verifyArgs,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const firstLine = (value) =>
  String(value ?? "").split("\n").find(Boolean) ?? "";

const main = async () => {
  const args = parseArgs();
  required(args, "language");
  const run = await runVerifyJson(args);
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(run.stderr || run.stdout || "verify did not produce JSON");
    process.exit(1);
  }

  const lines = [
    `# ${report.language} Grammar Harness Report`,
    "",
    `- Target: ${displayPath(report.target)}`,
    `- Overall: ${report.ok ? "PASS" : "FAIL"}`,
    `- Generation: ${report.generation.ok ? "ok" : "failed"}`,
    `- Generated files current: ${report.generation.current ? "yes" : "no"}`,
    `- File tests: ${
      report.fileTests.total - report.fileTests.failed.length
    }/${report.fileTests.total} passed`,
    `- Fixtures: ${
      report.fixtures.total - report.fixtures.failed.length
    }/${report.fixtures.total} passed, ${report.fixtures.errorNodes} error nodes`,
    `- Highlight snapshots: ${
      report.highlights.total - report.highlights.failed.length
    }/${report.highlights.total} passed`,
    "",
    "## Action Items",
    "",
  ];

  if (report.generation.stderr) {
    lines.push(
      `- Fix parser generation: ${firstLine(report.generation.stderr)}`,
    );
  }
  if (report.generation.mismatches.length) {
    lines.push(
      `- Regenerate stale files: ${report.generation.mismatches.join(", ")}`,
    );
  }
  for (const failure of report.fileTests.failed.slice(0, 5)) {
    lines.push(`- Repair parser fixture: ${failure.name}`);
  }
  for (const failure of report.fixtures.failed.slice(0, 5)) {
    lines.push(
      `- Reduce parse errors in ${failure.path}: ${failure.errors} > ${failure.maxErrorNodes}`,
    );
  }
  for (const failure of report.highlights.failed.slice(0, 5)) {
    lines.push(`- Update highlight snapshot or mapping: ${failure.name}`);
  }
  if (report.highlights.missingMappings.length) {
    lines.push(
      `- Exercise or remove unused highlight mappings: ${
        report.highlights.missingMappings.join(", ")
      }`,
    );
  }
  if (lines.at(-1) === "") lines.push("- none");

  console.log(lines.join("\n"));
  process.exit(report.ok ? 0 : 1);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
