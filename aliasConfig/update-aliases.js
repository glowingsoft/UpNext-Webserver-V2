const fs = require("fs");
const path = require("path");

const aliases = require("./pathAliases.config.js"); // same folder

const packageJsonPath = path.resolve(__dirname, "../package.json");
const jsConfigPath = path.resolve(__dirname, "../jsconfig.json");

// --- Helper: Safe JSON parser ---
function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(content);
  } catch (err) {
    console.error(`❌ Failed to parse JSON from ${filePath}`);
    console.error("Error:", err.message);
    process.exit(1);
  }
}

// --- Update package.json safely ---
const pkg = safeReadJson(packageJsonPath) || {};
pkg._moduleAliases = { ...aliases };
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");

// --- Update jsconfig.json safely ---
const jsConfig = safeReadJson(jsConfigPath) || { compilerOptions: {} };
jsConfig.compilerOptions.baseUrl = "./";
jsConfig.compilerOptions.paths = {};

Object.entries(aliases).forEach(([alias, target]) => {
  const ext = path.extname(target);
  if ([".js", ".ts", ".mjs", ".cjs"].includes(ext)) {
    // File alias
    jsConfig.compilerOptions.paths[alias] = [target];
  } else {
    // Directory alias
    jsConfig.compilerOptions.paths[`${alias}/*`] = [`${target}/*`];
  }
});

jsConfig.exclude = ["node_modules"];

fs.writeFileSync(jsConfigPath, JSON.stringify(jsConfig, null, 2) + "\n");

console.log("✅ Aliases synced successfully to package.json and jsconfig.json");
