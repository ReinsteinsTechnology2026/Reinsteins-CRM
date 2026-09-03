const express = require("express");
const upload = require("../middleware/fileUpload");
const {
  uploadFile,
} = require("../controllers/fileController");
const { protect } = require("../middleware/authMiddleware");

const router = express.Router();

// Previously had NO authentication at all -- confirmed unused by the
// current frontend (dead code), but adding `protect` here is required
// regardless: without an authenticated request, there is no tenant
// context to resolve a storage destination from at all.
router.post(
  "/upload",
  protect,
  upload.single("file"),
  uploadFile
);

module.exports = router;