const pool = require("../config/db");

// ==========================================
// DESIGNATION MANAGEMENT
//
// This is an admin-managed CATALOG only — it
// exists to power dropdowns/autocomplete and to
// let Admin curate the list of job titles in use.
// users.designation itself stays exactly as it
// already is: a free-text column, untouched by
// any of this. Nothing here enforces a foreign
// key from users.designation to this table.
// ==========================================

const getDesignations = async (req, res) => {
    try {

        const [designations] = await pool.query(
            `
            SELECT
                des.id,
                des.title,
                des.department_id,
                dep.name AS department_name,
                des.status,
                des.created_at,
                des.updated_at
            FROM designations des
            LEFT JOIN departments dep ON dep.id = des.department_id
            ORDER BY des.title
            `
        );

        return res.status(200).json({
            success: true,
            designations,
        });

    } catch (error) {
        console.error("Get Designations Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load designations",
        });
    }
};

const createDesignation = async (req, res) => {
    try {

        const { title, departmentId } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Designation title is required",
            });
        }

        const cleanedTitle = title.trim();

        const [existing] = await pool.query(
            `SELECT id FROM designations WHERE title = ? LIMIT 1`,
            [cleanedTitle]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: "This designation already exists",
            });
        }

        let cleanedDepartmentId = null;

        if (departmentId) {

            const [departments] = await pool.query(
                `SELECT id FROM departments WHERE id = ? LIMIT 1`,
                [departmentId]
            );

            if (departments.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Selected department not found",
                });
            }

            cleanedDepartmentId = departments[0].id;

        }

        const [result] = await pool.query(
            `
            INSERT INTO designations (title, department_id, status)
            VALUES (?, ?, 'active')
            RETURNING id
            `,
            [cleanedTitle, cleanedDepartmentId]
        );

        return res.status(201).json({
            success: true,
            message: "Designation created successfully",
            id: result[0].id,
        });

    } catch (error) {
        console.error("Create Designation Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to create designation",
        });
    }
};

const updateDesignation = async (req, res) => {
    try {

        const { id } = req.params;
        const { title, departmentId } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Designation title is required",
            });
        }

        const cleanedTitle = title.trim();

        const [duplicate] = await pool.query(
            `SELECT id FROM designations WHERE title = ? AND id != ? LIMIT 1`,
            [cleanedTitle, id]
        );

        if (duplicate.length > 0) {
            return res.status(409).json({
                success: false,
                message: "This designation already exists",
            });
        }

        let cleanedDepartmentId = null;

        if (departmentId) {

            const [departments] = await pool.query(
                `SELECT id FROM departments WHERE id = ? LIMIT 1`,
                [departmentId]
            );

            if (departments.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Selected department not found",
                });
            }

            cleanedDepartmentId = departments[0].id;

        }

        const [result] = await pool.query(
            `
            UPDATE designations
            SET title = ?, department_id = ?
            WHERE id = ?
            `,
            [cleanedTitle, cleanedDepartmentId, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Designation not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Designation updated successfully",
        });

    } catch (error) {
        console.error("Update Designation Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update designation",
        });
    }
};

const setDesignationStatus = async (req, res) => {
    try {

        const { id } = req.params;
        const { status } = req.body;

        if (!["active", "inactive"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid designation status",
            });
        }

        const [result] = await pool.query(
            `UPDATE designations SET status = ? WHERE id = ?`,
            [status, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Designation not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: `Designation ${status === "active" ? "activated" : "deactivated"} successfully`,
        });

    } catch (error) {
        console.error("Set Designation Status Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update designation status",
        });
    }
};

module.exports = {
    getDesignations,
    createDesignation,
    updateDesignation,
    setDesignationStatus,
};
