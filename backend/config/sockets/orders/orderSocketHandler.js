const mongoose = require("mongoose");

function orderSocketHandler(io, role) {
  io.on("connection", (socket) => {
    const auth = socket.handshake.auth || {};
    const query = socket.handshake.query || {};

    const userId = auth.userId || query.userId;
    const organizationId = auth.organizationId || query.organizationId;

    const { Types } = mongoose;

    /* ======================================================
       1️⃣ VALIDATE USER (REQUIRED FOR ALL ROLES)
       ====================================================== */
    if (!Types.ObjectId.isValid(userId)) {
      console.warn("❌ Socket rejected: invalid userId", { userId, role });
      socket.disconnect(true);
      return;
    }

    /* ======================================================
       2️⃣ USER SOCKET
       ====================================================== */
    if (role === "user") {
      socket.join(`user:${String(userId)}`);

      console.log("🟢 user connected", {
        userId,
        socketId: socket.id,
      });

      socket.on("disconnect", () => {
        console.log("🔴 user disconnected", { userId });
      });

      return;
    }

    /* ======================================================
       3️⃣ STAFF / ADMIN / COACH SOCKETS
       (ORGANIZATION IS REQUIRED)
       ====================================================== */
    if (!Types.ObjectId.isValid(organizationId)) {
      console.warn("❌ Socket rejected: missing or invalid organizationId", {
        userId,
        organizationId,
        role,
      });
      socket.disconnect(true);
      return;
    }

    socket.join(`org:${String(organizationId)}`);

    console.log(`🟢 ${role} connected`, {
      userId,
      organizationId,
      socketId: socket.id,
    });

    socket.on("disconnect", () => {
      console.log(`🔴 ${role} disconnected`, {
        userId,
        organizationId,
      });
    });
  });
}

module.exports = { orderSocketHandler };
