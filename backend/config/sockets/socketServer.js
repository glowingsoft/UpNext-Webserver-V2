// config/sockets/socketServer.js
const http = require("http");
const { Server } = require("socket.io");
const { initializeSockets } = require("./index");

function createSocketServer(app, allowedOrigins) {
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    },
  });

  // expose ONCE, globally
  global.io = io;

  initializeSockets(io);
             
  return server;
}

module.exports = { createSocketServer };
