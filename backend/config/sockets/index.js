const { attachRedisAdapter } = require("./socketRedisAdapter");
const { orderSocketHandler } = require("./orders/orderSocketHandler");
const chatSocketHandler = require("../../commonModules/chatModule/sockets/chatSocketHandler");

function initializeSockets(io) {
  attachRedisAdapter(io);

  chatSocketHandler(io.of("/chat"));
  orderSocketHandler(io.of("/client/orders"), "client");
  orderSocketHandler(io.of("/coach/orders"), "coach");
  orderSocketHandler(io.of("/admin/orders"), "admin");
  console.log("🚀 Sockets initialized");
}


module.exports = { initializeSockets };
