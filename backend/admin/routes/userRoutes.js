const express = require("express");
const auth = require("@middlewares/authMiddleware");

const {
  blockUser,
  reportUser,
  addOrUpdateSubscription,
  removeSubscription,
  getSubscriptions,
  getUserProfile,
  updateUserProfile,
  getOtherUserProfile,
  updateProfile,
  reviewCertifications,
  checkUserDeletionEligibility,
  deleteUserAccount,
  hardDeleteUserAccount,
} = require("../controllers/userController");
const roleMiddleware = require("@middlewares/roleMiddleware");
const { allUsers } = require("../controllers/adminPanelController");
const router = express.Router();

// Apply auth middleware to the router
router.use(auth);

// // Specify the fields you want to populate dynamically
// const fieldsToPopulate = [
//   "profileIcon",
//   "age",
// ];

router.get("/profile", (req, res, next) => {
  getUserProfile(req, res, next);
});

router.get("/profile/:userId", (req, res, next) => {
  getOtherUserProfile(req, res, next);
});

router.put("/profile", updateUserProfile);
router.get("/allUsers", roleMiddleware(["admin"]), allUsers);
router.put("/profile/:userId", roleMiddleware(["admin"]), updateProfile);
router.patch("/profile/:userId/certifications", roleMiddleware(["admin"]), reviewCertifications);
router.get(
  "/profile/:userId/deletion-eligibility",
  roleMiddleware(["admin"]),
  checkUserDeletionEligibility,
);
router.delete("/profile/:userId", roleMiddleware(["admin"]), deleteUserAccount);
router.delete("/profile/:userId/hard-delete", roleMiddleware(["admin"]), hardDeleteUserAccount);
router.post("/:userIdToBlock/block", blockUser);
router.post("/:userIdToReport/report", reportUser);
router.post("/add-update-subscription", addOrUpdateSubscription);
router.post("/remove-subscription/:subscriptionId", removeSubscription);
router.get("/subscriptions", getSubscriptions);

module.exports = router;
