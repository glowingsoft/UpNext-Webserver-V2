// security.js
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const cors = require("cors");
const compression = require("compression");
const express = require("express");
const { isDev, connectSrc } = require("@config/origins");
const securityMiddleware = (app, options = {}) => {
  const {
    allowedOrigins = [], // CORS allowed origins
    adminIPWhitelist = [], // IP whitelist for admin routes e.g "/api/admin" //  ["127.0.0.1", "203.0.113.42"], // Example whitelist
    maxRequestSize = "200mb", // Max request size for body parser
    rateLimitWindow = 15 * 60 * 1000, // 15 minutes for rate limiting
    rateLimitMax = 200, // limit each IP to 200 requests per windowMs
  } = options;

  // Security headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginEmbedderPolicy: true,
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      hsts: { maxAge: 31536000, includeSubDomains: true },
    })
  );

  // Prevent HTTP Parameter Pollution
  app.use(hpp());

  // Enable GZIP compression
  app.use(compression());

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: rateLimitWindow,
    max: rateLimitMax,
    message: {
      status: 429,
      message: "Too many requests from this IP, please try again later",
    },
  });
  // app.use(limiter);

  // Body parser limits (Express)
  // Stripe webhook needs the raw body for signature verification — skip JSON parsing there
  const jsonParser = express.json({ limit: maxRequestSize });
  app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/api/v1/stripe/webhook")) return next();
    return jsonParser(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: maxRequestSize }));

  // CORS configuration
  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (isDev) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS Forbidden"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-access-token", "x-language"],
  };

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

  // Optional JSON error for CORS
  app.use((err, req, res, next) => {
    if (err && err.message === "CORS Forbidden") {
      return res.status(403).json({ message: "CORS Forbidden" });
    }
    next();
  });



  // Optional: Admin IP whitelist for sensitive routes
  if (adminIPWhitelist.length > 0) {
    app.use("/api/admin", (req, res, next) => {
      const clientIP =
        req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress;
      if (!adminIPWhitelist.includes(clientIP)) {
        return res.status(403).json({ message: "Access denied for this IP" });
      }
      next();
    });
  }

  // Optional: Log suspicious requests
  app.use((req, res, next) => {
    if (!req.ip || !req.method || !req.path) {
      console.warn("Suspicious request detected:", req.ip, req.method, req.path);
    }
    next();
  });
};

module.exports = { securityMiddleware };
