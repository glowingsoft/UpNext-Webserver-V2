const mongoose = require("mongoose");

const DeviceSchema = mongoose.Schema({
  deviceId: {
    type: String,
    default: "",
    required: [true, "device_id_required"],
  },
  deviceType: {
    type: String,
    enum: ["android", "ios", "web"],
    default: "android",
    required: [true, "device_type_required"],
  },
});

const DevicesSchema = mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    devices: [DeviceSchema], // Array of device objects
  },
  {
    timestamps: true,
  }
);

const Devices = mongoose.model("device", DevicesSchema);

// Function to add a device after checking for duplicate deviceId
function createOrSkipDevice(userId, deviceId, deviceType) {
  setImmediate(async () => {
    try {
      if (deviceId === "test") return; // Skip test devices
      // Check if a device with the given deviceId already exists for this user
      const userDevice = await Devices.findOne({
        userId: userId,
        'devices.deviceId': deviceId,
      });

      if (userDevice) {
        return;  // Device already exists, so skip adding it
      }

      // If the deviceId doesn't exist, push the new device into the array
      await Devices.updateOne(
        { userId: userId }, // Find the user by userId
        { $push: { devices: { deviceId: deviceId, deviceType: deviceType } } }, // Add the new device
        { upsert: true }  // Use upsert to create a new user document if not found
      );

    } catch (error) {
      console.error("Error adding device:", error);
    }
  });
}


module.exports = {
  Devices,
  createOrSkipDevice,
};
