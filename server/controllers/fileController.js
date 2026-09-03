const path = require("path");

const { tenantUploadUrlPath } = require("../utils/tenantUploadPath");

const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded.",
      });
    }

    const file = req.file;

    return res.status(200).json({
      success: true,
      file: {
        originalName: file.originalname,
        fileName: file.filename,
        size: file.size,
        mimeType: file.mimetype,
        url: tenantUploadUrlPath("files", file.filename),
        extension: path.extname(file.originalname),
      },
    });
  } catch (error) {
    console.error("File Upload Error:", error);

    return res.status(500).json({
      success: false,
      message: "File upload failed.",
    });
  }
};

module.exports = {
  uploadFile,
};