const express = require("express");
const { getAllBusinesses } = require("../controllers/userController");
const { getPublicBusinessProfile } = require("../controllers/businessController");
const { getAllCategories } = require("@controllersCommonModules/categoryController");
const { getAllServices } = require("../controllers/serviceController");
const { getAllPackages } = require("../controllers/packageController");
const { recordVisit, getTraffic } = require("../controllers/trafficController");

// No auth middleware on this router — these endpoints back the logged-out
// browse/search screens (business cards + their filter dropdowns) and the
// "View Profile" detail page.
const router = express.Router();

router.get("/businesses", getAllBusinesses);
router.get("/services", getAllServices);
router.get("/packages", getAllPackages);
// matches as a businessId (and validateParams' ObjectId check would 400 it).
router.get("/businesses/:businessId", getPublicBusinessProfile);
router.get("/categories", getAllCategories);
router.post("/traffic/:profileId", recordVisit);
router.get("/traffic/:profileId", getTraffic);

module.exports = router;
