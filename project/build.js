#!/usr/bin/env node
/**
 * Rebuilds app.js from app.jsx.
 *
 * Run this after editing app.jsx. Requires the dev-time Babel packages
 * (see "Rebuilding after edits" in README.md):
 *
 *   npm install --no-save @babel/core @babel/preset-react
 *   node build.js
 */
const fs = require("fs");
const path = require("path");

let babel;
try {
  babel = require("@babel/core");
} catch (e) {
  console.error(
    "Missing @babel/core. Run:\n  npm install --no-save @babel/core @babel/preset-react\nthen try again."
  );
  process.exit(1);
}

const srcPath = path.join(__dirname, "app.jsx");
const outPath = path.join(__dirname, "app.js");

const source = fs.readFileSync(srcPath, "utf8");
const result = babel.transformSync(source, {
  // "classic" runtime compiles JSX to React.createElement(...) calls, which
  // is what app.js needs since it's loaded as a plain <script> — the
  // "automatic" runtime (Babel's default since v17) emits an ES module
  // `import` statement instead, which fails outside a <script type="module">.
  presets: [["@babel/preset-react", { runtime: "classic" }]],
  filename: "app.jsx",
});

fs.writeFileSync(outPath, result.code);
console.log(`Wrote ${outPath} (${result.code.length} bytes)`);
