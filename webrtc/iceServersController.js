const crypto = require("crypto");
const { sendResponse } = require("@utils/responseUtil");

const getIceServers = async (req, res) => {
    try {
        if (!process.env.TURN_SECRET) {
            return sendResponse({
                res,
                statusCode: 500,
                translationKey: "turn_server_not_configured"
            });
        }

        // Credentials valid for 24 hours
        const expiry = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

        // You can also use req.user._id if authenticated
        const username = `${expiry}`;

        const credential = crypto
            .createHmac("sha1", process.env.TURN_SECRET)
            .update(username)
            .digest("base64");

        return sendResponse({
            res, statusCode: 200,
            translationKey: "ice_servers_retrieved",
            data: {
                ttl: 86400,
                iceServers: [
                    {
                        urls: [
                            "stun:stun.l.google.com:19302",
                        ],
                    },
                    {
                        urls: [
                            `turn:${process.env.TURN_HOST}:3478?transport=udp`,
                            `turn:${process.env.TURN_HOST}:3478?transport=tcp`,
                        ],
                        username,
                        credential,
                    },
                ],
            }
        });
    } catch (error) {
        console.error("getIceServers:", error);

        return sendResponse({
            res,
            statusCode: 500,
            translationKey: "ice_servers_error",
            data: {
                error: error.message,
            },
        });
    }
};

module.exports = {
    getIceServers,
};