#!/usr/bin/env node
import { cp, mkdtemp, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanDir,
  displayPath,
  parseArgs,
  pathExists,
  readJson,
  readText,
  repoRoot,
  required,
  resolvePath,
  run,
  runChecked,
  writeJson,
  writeText,
} from "./common.mjs";

const corpusCase =
  /^\s*==+\n(.*)\n==+\n\s*([^]+?)\n---+\n\s*([^]+?)(?=\n==+|$)/g;

const titleCaseNode = (name) => {
  if (!name) return name;
  const clean = name.replace(/^_+/, "");
  return clean.charAt(0).toUpperCase() +
    clean.slice(1).replace(/_\w/g, (match) => match.slice(1).toUpperCase());
};

const convertCorpus = (source) => {
  const sections = [];
  let match;
  while ((match = corpusCase.exec(source))) {
    const [, name, code, tree] = match;
    const convertedTree = tree
      .replace(/\w+: */g, "")
      .replace(
        /\((\w+)(\)| *)/g,
        (_, node, suffix) =>
          `${titleCaseNode(node)}${suffix === ")" ? "" : "("}`,
      )
      .replace(
        /(\w|\))(\s+)(\w)/g,
        (_, before, space, after) => `${before},${space}${after}`,
      );
    sections.push(
      `# ${name.trim()}\n\n${code.trim()}\n\n==>\n\n${convertedTree.trim()}`,
    );
  }
  return sections.join("\n\n");
};

const extractCaptures = (source) =>
  [
    ...new Set(
      [...source.matchAll(/@([A-Za-z0-9_.-]+)/g)].map((match) => match[1]),
    ),
  ].sort();

const copyIfExists = async (from, to) => {
  if (!existsSync(from)) return false;
  await cp(from, to, { recursive: true });
  return true;
};

const resolveSource = async (source) => {
  const candidate = resolvePath(source, process.cwd());
  if (pathExists(candidate)) {
    return {
      sourceDir: candidate,
      provenance: { kind: "path", value: candidate },
    };
  }

  const packDir = await mkdtemp(join(tmpdir(), "weave-lezer-source-"));
  const pack = await runChecked("npm", [
    "pack",
    source,
    "--pack-destination",
    packDir,
  ], { cwd: repoRoot });
  const tgz = pack.stdout.trim().split(/\n/).at(-1);
  const packagePath = join(packDir, tgz);
  const extracted = join(packDir, "package");
  await runChecked("tar", ["-xzf", packagePath, "-C", packDir]);
  return {
    sourceDir: extracted,
    provenance: { kind: "npm", value: source, tarball: packagePath },
  };
};

const main = async () => {
  const args = parseArgs();
  const language = required(args, "language");
  const source = required(args, "source");
  const out = args.out && args.out !== true
    ? resolvePath(String(args.out), process.cwd())
    : join(tmpdir(), `weave-lezer-${language}-seed`);
  const apply = Boolean(args.apply);

  if (!apply && out.startsWith(repoRoot)) {
    throw new Error(
      "Refusing to write seed output inside the repo without --apply",
    );
  }

  await cleanDir(out);
  const { sourceDir, provenance } = await resolveSource(source);
  const sourceOut = join(out, "source");
  await cleanDir(sourceOut);

  const copied = [];
  for (
    const relative of [
      "package.json",
      "grammar.js",
      "src/grammar.json",
      "src/node-types.json",
      "src/scanner.c",
      "queries",
      "test/corpus",
    ]
  ) {
    if (
      await copyIfExists(join(sourceDir, relative), join(sourceOut, relative))
    ) copied.push(relative);
  }

  const report = {
    language,
    out,
    source: provenance,
    copied,
    generatedGrammar: null,
    convertedCorpusFiles: [],
    highlightCaptures: [],
    blockers: [],
  };

  const grammarJson = join(sourceDir, "src/grammar.json");
  if (pathExists(grammarJson)) {
    const importResult = await run("npm", [
      "exec",
      "--yes",
      "--package",
      "github:lezer-parser/import-tree-sitter",
      "--",
      "lezer-import-tree-sitter",
      grammarJson,
    ], { cwd: repoRoot });
    if (importResult.ok) {
      const generatedPath = join(out, `${language}.generated.grammar`);
      await writeText(generatedPath, importResult.stdout);
      report.generatedGrammar = generatedPath;
    } else {
      report.blockers.push({
        group: "tree-sitter-import",
        message: importResult.stderr || importResult.stdout ||
          "lezer-import-tree-sitter failed",
      });
    }
  } else {
    report.blockers.push({
      group: "tree-sitter-import",
      message: "No src/grammar.json found.",
    });
  }

  const corpusDir = join(sourceDir, "test/corpus");
  if (pathExists(corpusDir)) {
    const convertedDir = join(out, "converted-corpus");
    await cleanDir(convertedDir);
    for (const file of await readdir(corpusDir)) {
      const fullPath = join(corpusDir, file);
      if (!(await stat(fullPath)).isFile() || !file.endsWith(".txt")) continue;
      const converted = convertCorpus(await readText(fullPath));
      if (!converted.trim()) continue;
      const outputPath = join(convertedDir, file);
      await writeText(outputPath, converted);
      report.convertedCorpusFiles.push(outputPath);
    }
  }

  const highlights = join(sourceDir, "queries/highlights.scm");
  if (pathExists(highlights)) {
    report.highlightCaptures = extractCaptures(await readText(highlights));
    await writeJson(
      join(out, "highlight-captures.json"),
      report.highlightCaptures,
    );
  }

  if (pathExists(join(sourceDir, "package.json"))) {
    report.sourcePackage = await readJson(join(sourceDir, "package.json"));
  }

  await writeJson(join(out, "harness-report.json"), report);
  await writeText(
    join(out, "HARNESS_REPORT.md"),
    [
      `# ${language} Seed Report`,
      "",
      `- Output: ${out}`,
      `- Source: ${provenance.kind} ${provenance.value}`,
      `- Copied: ${copied.length ? copied.join(", ") : "none"}`,
      `- Generated grammar: ${
        report.generatedGrammar
          ? displayPath(report.generatedGrammar)
          : "not generated"
      }`,
      `- Converted corpus files: ${report.convertedCorpusFiles.length}`,
      `- Highlight captures: ${report.highlightCaptures.length}`,
      "",
      "## Blockers",
      "",
      report.blockers.length
        ? report.blockers.map((blocker) =>
          `- ${blocker.group}: ${String(blocker.message).split("\n")[0]}`
        ).join("\n")
        : "- none",
      "",
    ].join("\n"),
  );

  console.log(`Seeded ${language} harness workspace at ${out}`);
  console.log(`Report: ${join(out, "HARNESS_REPORT.md")}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
