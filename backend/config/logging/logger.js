const fs = require("fs");
const path = require("path");

const isProd = process.env.NODE_ENV === "prod";
const LOG_DIR = path.resolve(__dirname, "../../../logs/app");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    pid: process.pid,
    workerId: process.env.NODE_APP_INSTANCE,
    message,
    ...meta,
  };

  const line = JSON.stringify(entry) + "\n";

  if (level === "ERROR" || level === "WARN") {
    fs.appendFileSync(path.join(LOG_DIR, "error.log"), line);
  } else {
    const date = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `app-${date}.log`), line);
  }

  if (!isProd) console.log(line.trim());
}

module.exports = {
  log: (msg, meta) => !isProd && write("DEBUG", msg, meta),
  info: (msg, meta) => write("INFO", msg, meta),
  warn: (msg, meta) => write("WARN", msg, meta),
  error: (msg, meta) => write("ERROR", msg, meta),
};
