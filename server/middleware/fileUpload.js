const multer = require("multer");
const path = require("path");

const { tenantUploadAbsoluteDir } = require("../utils/tenantUploadPath");

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, tenantUploadAbsoluteDir(req, "files"));
  },

  filename(req, file, cb) {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9);

    cb(
      null,
      uniqueName +
        path.extname(file.originalname)
    );
  },
});

const allowedExtensions = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".zip",
  ".rar",
];

const upload = multer({
  storage,

  limits: {
    fileSize: 50 * 1024 * 1024,
  },

  fileFilter(req, file, cb) {
    const extension =
      path.extname(file.originalname)
        .toLowerCase();

    if (
      allowedExtensions.includes(extension)
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported file type."
        )
      );
    }
  },
});

module.exports = upload;