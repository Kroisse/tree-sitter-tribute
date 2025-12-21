#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/bump-version.mjs <version>");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function replaceFirst(text, regex, replacement) {
  if (!regex.test(text)) {
    throw new Error(`pattern not found: ${regex}`);
  }
  return text.replace(regex, replacement);
}

const updates = [
  {
    file: "Cargo.toml",
    replacers: [
      {
        regex: /^version\s*=\s*"[^"]+"/m,
        replacement: `version = "${version}"`,
      },
    ],
  },
  {
    file: "package.json",
    replacers: [
      {
        regex: /"version"\s*:\s*"[^"]+"/,
        replacement: `"version": "${version}"`,
      },
    ],
  },
  {
    file: "tree-sitter.json",
    replacers: [
      {
        regex: /"version"\s*:\s*"[^"]+"/,
        replacement: `"version": "${version}"`,
      },
    ],
  },
  {
    file: "pyproject.toml",
    replacers: [
      {
        regex: /^version\s*=\s*"[^"]+"/m,
        replacement: `version = "${version}"`,
      },
    ],
  },
  {
    file: "build.zig.zon",
    replacers: [
      {
        regex: /\.version\s*=\s*"[^"]+"/,
        replacement: `.version = "${version}"`,
      },
    ],
  },
  {
    file: "pom.xml",
    replacers: [
      {
        regex: /(<project[\s\S]*?<version>)([^<]+)(<\/version>)/,
        replacement: `$1${version}$3`,
      },
    ],
  },
];

for (const update of updates) {
  const filePath = path.join(root, update.file);
  let text = fs.readFileSync(filePath, "utf8");
  for (const { regex, replacement } of update.replacers) {
    text = replaceFirst(text, regex, replacement);
  }
  fs.writeFileSync(filePath, text);
}

console.log(`Bumped version to ${version}`);
