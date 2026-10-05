function emitOrderEvent({
  io,
  eventName,
  orderId,
  organizationId,
  userId,
  data = {},
}) {
  const payload = {
    event: eventName,
    orderId: String(orderId),
    organizationId: organizationId ? String(organizationId) : null,
    data,
    timestamp: Date.now(),
  };

  // console.log(
  //   `📡 Emitting ${eventName} → order ${orderId}` +
  //   (organizationId ? ` | org ${organizationId}` : " | NO ORG")
  // );
  // console.log("Payload:", payload);

  /* ======================================================
     👥 ORG-SCOPED EMITS (ONLY IF orgId EXISTS)
     ====================================================== */
  if (organizationId) {
    io.of("/staff/orders")
      .to(`org:${organizationId}`)
      .emit(eventName, payload);

    io.of("/admin/orders")
      .to(`org:${organizationId}`)
      .emit(eventName, payload);

    io.of("/organizer/orders")
      .to(`org:${organizationId}`)
      .emit(eventName, payload);
  }

  /* ======================================================
     👤 USER-SCOPED EMIT (INDEPENDENT OF ORG)
     ====================================================== */
  if (userId) {
    io.of("/user/orders")
      .to(`user:${String(userId)}`)
      .emit(eventName, payload);
  }
}
module.exports = { emitOrderEvent };
