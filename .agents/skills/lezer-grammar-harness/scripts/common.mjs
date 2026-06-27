import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
export const skillDir = resolve(scriptDir, "..");
export const repoRoot = resolve(scriptDir, "../../../..");

export const parseArgs = (argv = process.argv.slice(2)) => {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq > -1 ? eq : undefined);
    if (eq > -1) {
      result[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
};

export const required = (args, key) => {
  const value = args[key];
  if (!value || value === true) throw new Error(`Missing required --${key}`);
  return String(value);
};

export const resolvePath = (value, cwd = repoRoot) =>
  isAbsolute(value) ? value : resolve(cwd, value);

export const pathExists = (path) => existsSync(path);

export const readText = (path) => readFile(path, "utf8");

export const writeText = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

export const readJson = async (path) => JSON.parse(await readText(path));

export const writeJson = (path, value) =>
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const run = (command, args, options = {}) =>
  new Promise((resolveRun) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolveRun({
        ok: false,
        code: -1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
        command,
        args,
        cwd: options.cwd ?? repoRoot,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolveRun({
        ok: code === 0,
        code,
        stdout,
        stderr,
        command,
        args,
        cwd: options.cwd ?? repoRoot,
      });
    });
  });

export const runChecked = async (command, args, options = {}) => {
  const result = await run(command, args, options);
  if (!result.ok) {
    const rendered = `${command} ${args.join(" ")}`;
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${rendered} failed with exit code ${result.code}${
        details ? `\n${details}` : ""
      }`,
    );
  }
  return result;
};

export const lezerGeneratorCommand = () => {
  const candidates = [
    join(repoRoot, "desktop/node_modules/.bin/lezer-generator"),
    join(repoRoot, "node_modules/.bin/lezer-generator"),
  ];
  const found = candidates.find(pathExists);
  if (found) return { command: found, prefixArgs: [] };
  return {
    command: "npx",
    prefixArgs: [
      "--yes",
      "--package",
      "@lezer/generator@1.8.0",
      "--",
      "lezer-generator",
    ],
  };
};

export const runLezerGenerator = (args, options = {}) => {
  const { command, prefixArgs } = lezerGeneratorCommand();
  return run(command, [...prefixArgs, ...args], options);
};

export const runLezerGeneratorChecked = (args, options = {}) => {
  const { command, prefixArgs } = lezerGeneratorCommand();
  return runChecked(command, [...prefixArgs, ...args], options);
};

export const cleanDir = async (path) => {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
};

export const displayPath = (path) => {
  const resolved = resolve(path);
  return resolved.startsWith(repoRoot)
    ? resolved.slice(repoRoot.length + 1)
    : resolved;
};

export const defaultTargetFor = (language) =>
  join(repoRoot, `packages/client/src/lib/codemirror-${language}`);

export const findGrammarFile = (target, language) => {
  const preferred = join(target, `${language}.grammar`);
  if (pathExists(preferred)) return preferred;
  const fallback = join(
    target,
    `${basename(target).replace(/^codemirror-/, "")}.grammar`,
  );
  if (pathExists(fallback)) return fallback;
  throw new Error(`No grammar file found in ${displayPath(target)}`);
};
