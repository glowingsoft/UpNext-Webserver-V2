/**
 * ------------------------------------------------
 * Unified Logging (FIRST – before anything else)
 * ------------------------------------------------
 */
require("../backend/config/logging");
const { logger, crashLogger, accessLogger } = require("../backend/config/logging");

// expose globally (safe + intentional)
global.logger = logger;

/**
 * ------------------------------------------------
 * Env
 * ------------------------------------------------
 */
require("dotenv").config();

require("express-async-errors");
const express = require("express");
const morgan = require("morgan");
const path = require("path");
const moduleAlias = require("module-alias");

/**
 * ------------------------------------------------
 * Module aliases
 * ------------------------------------------------
 */
const aliases = require("../aliasConfig/pathAliases.config");
for (const [alias, target] of Object.entries(aliases)) {
  moduleAlias.addAlias(alias, path.join(__dirname, "..", target));
}
require("module-alias/register");

/**
 * ------------------------------------------------
 * App & Infra Imports
 * ------------------------------------------------
 */
const { i18nConfig } = require("@config/i18nConfig");
const { securityMiddleware } = require("@middlewares/security");
const { textModerationMiddleware } = require("@services/moderation/textModeration");
const { checkLanguage } = require("@middlewares/languageMiddleware");
const { sendResponse } = require("@utils/responseUtil");

const connectToDB = require("@utils/server-setup");
// const { initTextModeration } = require("@services/moderation/textModeration");
// const { backupMongoDB } = require("@utils/dataBaseBackup");
// const { getRedisClient } = require("@config/redis/redisConfig");
const { startCrons } = require("@config/cron");

/**
 * ------------------------------------------------
 * Socket Server
 * ------------------------------------------------
 */
const { createSocketServer } = require("@socketIo/socketServer");

/**
 * ------------------------------------------------
 * Swagger
 * ------------------------------------------------
 */
const swaggerUi = require("swagger-ui-express");
const fs = require("fs");

const swaggerDir = path.join(__dirname, "..", "swagger");
const swaggerFilePath = path.join(swaggerDir, "swagger_output.json");

if (!fs.existsSync(swaggerDir)) {
  fs.mkdirSync(swaggerDir, { recursive: true });
}

if (!fs.existsSync(swaggerFilePath)) {
  const defaultSwagger = {
    openapi: "3.0.0",
    info: {
      title: "MERN UpNext API",
      description: "API documentation for MERN UpNext",
      version: "1.0.0",
    },
    servers: [{ url: "http://localhost:8080/api/v1", description: "Development server" }],
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };
  fs.writeFileSync(swaggerFilePath, JSON.stringify(defaultSwagger, null, 2));
}

const swaggerFile = require("../swagger/swagger_output.json");
const { allowedOrigins } = require("@config/origins");

/**
 * =======================================================
 * Express App
 * =======================================================
 */
const app = express();
app.set("trust proxy", 1);

/**
 * ------------------------------------------------
 * Health & Root
 * ------------------------------------------------
 */
app.get("/api", (req, res) => {
  res.json({
    name: "Project API",
    version: "v1",
    status: "running",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
  });
});

/**
 * =======================================================
 * Security
 * =======================================================
 */
securityMiddleware(app, {
  allowedOrigins,
  adminIPWhitelist: [],
  maxRequestSize: "10mb",
  rateLimitWindow: 15 * 60 * 1000,
  rateLimitMax: 200,
});

/**
 * =======================================================
 * Middlewares
 * =======================================================
 */
app.use(i18nConfig.init);
app.use(checkLanguage);

// ✅ unified access logs
app.use(accessLogger);

// keep existing middleware (unchanged)
if (process.env.NODE_ENV !== "prod") {
  app.use(morgan("dev"));
}

app.use("/api/v1/stripe", require("./commonModules/routes/stripeRoutes.js"));
app.use(express.json());
app.use(textModerationMiddleware);

/**
 * ------------------------------------------------
 * Routes
 * ------------------------------------------------
 */
const routes = require("./commonModules/routes");
const adminRoutes = require("./admin/routes");
const appRoutes = require("./app/routes");
const {getRedisClient} = require("@config/redis/redisConfig");

app.use("/api/v1/app", appRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1", routes);

// Swagger
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerFile));

// Fallback
app.use((req, res) => {
  sendResponse({
    res,
    statusCode: 404,
    translationKey: "route_not_found",
  });
});

/**
 * =======================================================
 * Global Express Error Handler
 * =======================================================
 */
app.use((err, req, res, next) => {
  logger.error("Request error", {
    method: req.method,
    path: req.originalUrl,
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    message: "Internal server error",
  });
});

/**
 * =======================================================
 * Socket + HTTP Server
 * =======================================================
 */
const server = createSocketServer(app, allowedOrigins);

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
    logger.info("HTTP server listening", {
        port: PORT,
        env: process.env.NODE_ENV,
    });
});


/**
 * =======================================================
 * Start Server AFTER DB Connection
 * =======================================================
 */

(async () => {
  try {
    await connectToDB();
    // await initTextModeration();
    getRedisClient();
    startCrons();
    // setInterval(backupMongoDB, 24 * 60 * 60 * 1000);
  } catch (err) {
    logger.fatal("Startup failure", {
      error: err.message,
      stack: err.stack,
    });
  }
})();

/**
 * =======================================================
 * Graceful shutdown (expected)
 * =======================================================
 */
const shutdown = async (signal) => {
  logger.warn("Shutdown signal received", { signal });

  try {
    if (global.io) {
      await global.io.close();
      logger.info("Socket.IO closed");
    }
    process.exit(0);
  } catch (err) {
    logger.error("Error during graceful shutdown", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/**
 * =======================================================
 * Crash handlers (unexpected)
 * =======================================================
 */
process.on("unhandledRejection", (reason, promise) => {
  crashLogger.fatal("Unhandled Promise Rejection", {
    reason: reason?.message || reason,
    stack: reason?.stack,
  });

  // Give logger time to flush
  setTimeout(() => {
    process.exit(1);
  }, 100);
});

process.on("uncaughtException", (err) => {
  crashLogger.fatal("Uncaught Exception", {
    error: err.message,
    stack: err.stack,
  });

  setTimeout(() => {
    process.exit(1);
  }, 100);
});
