const fs = require("fs");
const path = require("path");

const pool = require("../config/db");
const { tenantUploadUrlPath, UPLOADS_ROOT } = require("../utils/tenantUploadPath");

// ==========================================
// SOP LIBRARY (Phase 17c)
//
// Tenant scoping: every query here runs through `pool` from
// config/db.js, the same AsyncLocalStorage-backed tenant-aware proxy
// every other controller in this codebase uses -- it always resolves
// to the CALLER's own tenant database. No company_id column exists on
// "sops" (see the schema file comment); isolation comes entirely from
// which physical database this connection is pointed at, exactly
// like shift_schedules (Phase 17b).
//
// File storage/serving reuses the EXISTING secure multi-tenant file
// pipeline as-is -- no new serving route, no new signing logic:
//   - upload destination: tenantUploadAbsoluteDir(req, "sops") inside
//     sopUploadMiddleware.js's multer config (never AsyncLocalStorage
//     inside the destination callback -- see that file's comment)
//   - stored URL: tenantUploadUrlPath("sops", filename), returned as
//     a plain "/uploads/..." string
//   - signing: signFileUrlsMiddleware.js (mounted globally in app.js)
//     automatically signs any "/uploads/..." string found anywhere in
//     a JSON response -- this controller does not call signFileUrl
//     itself, matching every other controller that returns a file
//     path
//   - serving: the existing GET /uploads/*splat route in app.js
//     (token + tenant-segment + path-traversal checks, all already
//     category-agnostic) -- nothing there needed to change for a new
//     "sops" category
// ==========================================

// ==========================================
// GET /api/sops
// Any authenticated tenant user -- read-only for everyone.
// ==========================================

const listSops = async (req, res) => {
  try {
    const [sops] = await pool.query(
      `
      SELECT
        s.id,
        s.title,
        s.original_filename,
        s.file_path,
        s.file_size,
        s.mime_type,
        s.uploaded_by,
        u.full_name AS uploaded_by_name,
        s.created_at,
        s.updated_at
      FROM sops s
      LEFT JOIN users u ON u.id = s.uploaded_by
      ORDER BY s.created_at DESC
      `
    );

    return res.status(200).json({
      success: true,
      sops,
    });

  } catch (error) {
    console.error("List SOPs Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load SOPs",
    });
  }
};

// ==========================================
// POST /api/sops
// Admin/Super Admin only (route-gated). multer (sopUploadMiddleware)
// has already run by the time this executes.
// ==========================================

const createSop = async (req, res) => {
  try {
    const { title } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please select a file to upload",
      });
    }

    if (!title?.trim()) {
      // Clean up the file multer already wrote to disk -- otherwise a
      // missing-title retry leaves an orphaned upload behind.
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error("Unable to remove orphaned SOP upload:", cleanupError);
      }

      return res.status(400).json({
        success: false,
        message: "SOP title is required",
      });
    }

    const filePath = tenantUploadUrlPath("sops", req.file.filename);

    const [result] = await pool.query(
      `
      INSERT INTO sops
        (title, original_filename, stored_filename, file_path, file_size, mime_type, uploaded_by)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
      `,
      [
        title.trim(),
        req.file.originalname,
        req.file.filename,
        filePath,
        req.file.size,
        req.file.mimetype,
        req.user.id,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "SOP uploaded successfully",
      id: result[0].id,
    });

  } catch (error) {
    console.error("Create SOP Error:", error);

    // Best-effort cleanup of the file multer already wrote, so a DB
    // failure doesn't leave an orphaned, unreferenced file on disk.
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error("Unable to remove orphaned SOP upload after DB error:", cleanupError);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Unable to upload SOP",
    });
  }
};

// ==========================================
// DELETE /api/sops/:id
// Admin/Super Admin only (route-gated).
// ==========================================

const deleteSop = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT id, file_path FROM sops WHERE id = ? LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "SOP not found",
      });
    }

    const sop = rows[0];

    await pool.query(`DELETE FROM sops WHERE id = ?`, [id]);

    // Same bounded-unlink pattern already used for profile photos
    // (employeeController.js) -- resolve against UPLOADS_ROOT and
    // refuse to unlink anything that resolves outside it, regardless
    // of what file_path contains.
    const absolutePath = path.join(UPLOADS_ROOT, sop.file_path.replace(/^\/uploads\//, ""));
    const isInsideUploads =
      absolutePath === UPLOADS_ROOT || absolutePath.startsWith(UPLOADS_ROOT + path.sep);

    if (isInsideUploads && fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (deleteError) {
        console.error("Unable to delete SOP file:", deleteError);
      }
    }

    return res.status(200).json({
      success: true,
      message: "SOP deleted successfully",
    });

  } catch (error) {
    console.error("Delete SOP Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to delete SOP",
    });
  }
};

module.exports = {
  listSops,
  createSop,
  deleteSop,
};
