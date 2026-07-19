import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const readmePath = "README.md";
const languageSvgPath = "metrics/metrics.languages.svg";

function cacheKey(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

const svg = await readFile(languageSvgPath);
const key = cacheKey(svg);
const readme = await readFile(readmePath, "utf8");
const updated = readme.replace(
  /src="\.\/metrics\/metrics\.languages\.svg(?:\?v=[^"]*)?"/,
  `src="./metrics/metrics.languages.svg?v=${key}"`,
);

if (updated === readme) {
  throw new Error("Could not find language metrics image reference in README.md.");
}

await writeFile(readmePath, updated, "utf8");
console.log(`Updated README language metrics cache key: ${key}`);
