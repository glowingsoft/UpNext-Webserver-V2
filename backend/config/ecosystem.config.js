const fs = require("fs");
const path = require("path");

/**
 * Root log directory
 */
const LOG_ROOT = path.resolve(__dirname, "../../logs");
const PM2_LOG_DIR = path.join(LOG_ROOT, "pm2");

/**
 * PM2 will NOT create folders — we must
 */
if (!fs.existsSync(LOG_ROOT)) {
  fs.mkdirSync(LOG_ROOT, { recursive: true });
}

if (!fs.existsSync(PM2_LOG_DIR)) {
  fs.mkdirSync(PM2_LOG_DIR, { recursive: true });
}

module.exports = {
  apps: [
    {
      name: "UpNext-Backend",
      script: "backend/server.js",

      exec_mode: "cluster",
      instances: "max",

      max_memory_restart: "1500M",
      kill_timeout: 8000,
      listen_timeout: 8000,

      restart_delay: 2000,
      exp_backoff_restart_delay: 100,

      /**
       * PM2-managed logs
       */
      output: path.join(PM2_LOG_DIR, "out.log"),
      error: path.join(PM2_LOG_DIR, "error.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      env: {
        NODE_ENV: "dev",
        PORT: process.env.PORT || 4001,
      },

      env_prod: {
        NODE_ENV: "prod",
        PORT: process.env.PORT || 4002,
      },
    },
  ],
};
