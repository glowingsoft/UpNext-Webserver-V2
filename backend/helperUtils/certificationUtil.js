// Certification review gate.
//
// Once a business submits certifications they stay in review until an admin
// approves them (`admin/controllers/userController.reviewCertifications`).
// While the submission is unresolved — pending review, or rejected and not yet
// resubmitted — the business must not be able to publish new services or
// packages. Businesses that never submitted ("not_submitted") are unaffected.
//
// Returns a translationKey describing the block, or null when creation is allowed.
const getCertificationBlockKey = (certifications) => {
  switch (certifications?.status) {
    case "pending":
      return "certifications_pending_approval";
    case "rejected":
      return "certifications_not_approved";
    default:
      return null;
  }
};

module.exports = { getCertificationBlockKey };
