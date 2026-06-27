#!/usr/bin/env node
import { createRequire } from "node:module";
import { cp, mkdtemp, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultTargetFor,
  displayPath,
  findGrammarFile,
  parseArgs,
  pathExists,
  readJson,
  readText,
  repoRoot,
  required,
  resolvePath,
  runLezerGenerator,
  runLezerGeneratorChecked,
  sha256,
  writeJson,
  writeText,
} from "./common.mjs";

const normalizeTree = (value) => value.trim().replace(/[ \t]+$/gm, "");

const parseFileTests = (source) => {
  return source
    .trim()
    .split(/\n(?=# )/g)
    .map((section) => /^# ([^\n]+)\n([^]+?)\n==>\n\s*([^]+)$/m.exec(section))
    .filter(Boolean)
    .map((match) => ({
      name: match[1].trim(),
      input: match[2].trim(),
      expected: normalizeTree(match[3]),
    }));
};

const countErrorNodes = (tree) => {
  let count = 0;
  const cursor = tree.cursor();
  do {
    if (cursor.name === "⚠") count += 1;
  } while (cursor.next());
  return count;
};

const collectHighlightSpans = (tree, source, highlightMap) => {
  const spans = [];
  const seen = new Set();
  const cursor = tree.cursor();
  do {
    const category = highlightMap[cursor.name];
    if (!category) continue;
    const text = source.slice(cursor.from, cursor.to);
    if (!text.trim()) continue;
    const key = `${cursor.from}:${cursor.to}:${cursor.name}:${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({
      from: cursor.from,
      to: cursor.to,
      text,
      node: cursor.name,
      category,
    });
  } while (cursor.next());
  return spans;
};

const compareGenerated = async (target, temp, apply) => {
  const generated = [];
  const mismatches = [];
  for (const file of ["parser.ts", "parser.terms.ts"]) {
    const actualPath = join(target, file);
    const nextPath = join(temp, file);
    const actualExists = pathExists(actualPath);
    const next = await readText(nextPath);
    const actual = actualExists ? await readText(actualPath) : "";
    generated.push({ file, hash: sha256(next) });
    if (!actualExists || actual !== next) {
      mismatches.push(file);
      if (apply) await writeText(actualPath, next);
    }
  }
  return { generated, current: mismatches.length === 0, mismatches };
};

const main = async () => {
  const args = parseArgs();
  const language = required(args, "language");
  const target = args.target && args.target !== true
    ? resolvePath(String(args.target), process.cwd())
    : defaultTargetFor(language);
  const apply = Boolean(args.apply);
  const json = Boolean(args.json);
  const grammarFile = findGrammarFile(target, language);
  const temp = await mkdtemp(join(tmpdir(), `weave-lezer-${language}-verify-`));
  const tempGrammar = join(temp, `${language}.grammar`);
  await cp(grammarFile, tempGrammar);

  const result = {
    language,
    target,
    ok: true,
    generation: { ok: false, current: false, mismatches: [], stderr: "" },
    fileTests: { ok: true, total: 0, failed: [] },
    fixtures: { ok: true, total: 0, failed: [], errorNodes: 0 },
    highlights: {
      ok: true,
      total: 0,
      failed: [],
      missingMappings: [],
      generated: null,
    },
  };

  const tsGeneration = await runLezerGenerator([
    "--typeScript",
    "--names",
    `${language}.grammar`,
    "-o",
    "parser",
  ], { cwd: temp });
  if (!tsGeneration.ok) {
    result.ok = false;
    result.generation = {
      ok: false,
      current: false,
      mismatches: [],
      stderr: tsGeneration.stderr || tsGeneration.stdout,
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.error(result.generation.stderr);
    process.exit(1);
  }
  const generated = await compareGenerated(target, temp, apply);
  result.generation = {
    ok: true,
    current: generated.current,
    mismatches: generated.mismatches,
    stderr: "",
  };
  if (!generated.current) result.ok = false;

  const cjsGeneration = await runLezerGenerator([
    "--cjs",
    "--names",
    `${language}.grammar`,
    "-o",
    "parser.cjs",
  ], { cwd: temp });
  if (!cjsGeneration.ok) {
    result.ok = false;
    result.generation.ok = false;
    result.generation.stderr = cjsGeneration.stderr || cjsGeneration.stdout;
  } else {
    const desktopNodeModules = join(repoRoot, "desktop/node_modules");
    if (existsSync(desktopNodeModules)) {
      await symlink(desktopNodeModules, join(temp, "node_modules"), "dir")
        .catch(() => undefined);
    }
    const tokenShim = join(target, "test/tokens.cjs");
    if (existsSync(tokenShim)) await cp(tokenShim, join(temp, "tokens.js"));
    const require = createRequire(join(temp, "verify.cjs"));
    const { parser } = require(join(temp, "parser.cjs"));

    const parserTest = join(target, "test/parser.txt");
    if (pathExists(parserTest)) {
      for (const test of parseFileTests(await readText(parserTest))) {
        result.fileTests.total += 1;
        const actual = normalizeTree(parser.parse(test.input).toString());
        if (actual !== test.expected) {
          result.fileTests.ok = false;
          result.ok = false;
          result.fileTests.failed.push({
            name: test.name,
            expected: test.expected,
            actual,
          });
        }
      }
    }

    const fixtureManifest = join(target, "test/fixtures.json");
    if (pathExists(fixtureManifest)) {
      for (const fixture of await readJson(fixtureManifest)) {
        const fixturePath = join(target, fixture.path);
        const source = await readText(fixturePath);
        const tree = parser.parse(source);
        const errors = countErrorNodes(tree);
        result.fixtures.total += 1;
        result.fixtures.errorNodes += errors;
        if (errors > (fixture.maxErrorNodes ?? 0)) {
          result.fixtures.ok = false;
          result.ok = false;
          result.fixtures.failed.push({
            path: fixture.path,
            errors,
            maxErrorNodes: fixture.maxErrorNodes ?? 0,
          });
        }
      }
    }

    const highlightMapPath = join(target, "highlight-map.json");
    if (pathExists(highlightMapPath)) {
      const highlightMap = await readJson(highlightMapPath);
      const mappedNodes = new Set(Object.keys(highlightMap));
      const snapshotPath = join(target, "test/highlight-snapshots.json");
      const generatedSnapshots = [];
      const snapshotCases = pathExists(snapshotPath)
        ? await readJson(snapshotPath)
        : [];
      for (const item of snapshotCases) {
        const source = item.source ?? await readText(join(target, item.path));
        const spans = collectHighlightSpans(
          parser.parse(source),
          source,
          highlightMap,
        );
        result.highlights.total += 1;
        generatedSnapshots.push({ name: item.name, source, spans });
        if (JSON.stringify(spans) !== JSON.stringify(item.spans)) {
          result.highlights.ok = false;
          result.ok = false;
          result.highlights.failed.push({
            name: item.name,
            expected: item.spans,
            actual: spans,
          });
        }
      }
      result.highlights.generated = generatedSnapshots;

      const smokeSource = snapshotCases.map((item) => item.source ?? "").join(
        "\n",
      );
      if (smokeSource) {
        const tree = parser.parse(smokeSource);
        const seen = new Set();
        const cursor = tree.cursor();
        do {
          if (mappedNodes.has(cursor.name)) seen.add(cursor.name);
        } while (cursor.next());
        result.highlights.missingMappings = [...mappedNodes].filter((name) =>
          !seen.has(name)
        );
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${language} grammar verification`,
    );
    console.log(`target: ${displayPath(target)}`);
    console.log(
      `generation: ${result.generation.ok ? "ok" : "failed"}; current: ${
        result.generation.current ? "yes" : "no"
      }`,
    );
    if (result.generation.mismatches.length) {
      console.log(
        `stale generated files: ${result.generation.mismatches.join(", ")}`,
      );
    }
    console.log(
      `file tests: ${
        result.fileTests.total - result.fileTests.failed.length
      }/${result.fileTests.total} passed`,
    );
    console.log(
      `fixtures: ${
        result.fixtures.total - result.fixtures.failed.length
      }/${result.fixtures.total} passed; error nodes: ${result.fixtures.errorNodes}`,
    );
    console.log(
      `highlight snapshots: ${
        result.highlights.total - result.highlights.failed.length
      }/${result.highlights.total} passed`,
    );
  }

  process.exit(result.ok ? 0 : 1);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
