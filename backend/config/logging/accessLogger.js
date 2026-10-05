const fs = require("fs");
const path = require("path");

module.exports = (req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const log = {
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
      pid: process.pid,
      workerId: process.env.NODE_APP_INSTANCE,
    };

    const file = path.resolve(
      __dirname,
      "../../../logs/access/access-" +
        new Date().toISOString().slice(0, 10) +
        ".log"
    );

    fs.appendFileSync(file, JSON.stringify(log) + "\n");
  });

  next();
};
