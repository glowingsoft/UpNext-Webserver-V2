const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../../logs");
const DIRS = ["app", "crash", "access", "pm2"];
const MAX_DAYS = 7;

function ensureDirs() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT);
  DIRS.forEach(d => {
    const p = path.join(ROOT, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });
}

function cleanupOldLogs(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return;

  const now = Date.now();
  fs.readdirSync(full).forEach(file => {
    const filePath = path.join(full, file);
    const stat = fs.statSync(filePath);
    const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_DAYS) fs.unlinkSync(filePath);
  });
}

ensureDirs();
DIRS.forEach(cleanupOldLogs);
