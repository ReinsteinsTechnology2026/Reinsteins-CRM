const pool = require("../config/db");

const {
    recordOrganizationHistory,
} = require("../services/organizationService");

// ==========================================
// LIST DEPARTMENTS (with head name + employee count)
// Available to any authenticated user — reading
// department names/heads is not sensitive, and
// dropdowns (Add Employee, transfer, etc.) need
// this broadly.
// ==========================================

const getDepartments = async (req, res) => {
    try {

        const [departments] = await pool.query(
            `
            SELECT
                dep.id,
                dep.name,
                dep.code,
                dep.description,
                dep.department_head_id,
                head.full_name AS department_head_name,
                head.employee_id AS department_head_employee_id,
                dep.status,
                dep.created_at,
                dep.updated_at,
                COUNT(u.id) AS member_count
            FROM departments dep
            LEFT JOIN users head ON head.id = dep.department_head_id
            LEFT JOIN users u
                ON u.department_id = dep.id
                AND u.employment_status = 'active'
            GROUP BY dep.id, head.full_name, head.employee_id
            ORDER BY dep.name
            `
        );

        return res.status(200).json({
            success: true,
            departments,
        });

    } catch (error) {
        console.error("Get Departments Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load departments",
        });
    }
};

// ==========================================
// GET ONE DEPARTMENT
// ==========================================

const getDepartmentById = async (req, res) => {
    try {

        const { id } = req.params;

        const [departments] = await pool.query(
            `
            SELECT
                dep.*,
                head.full_name AS department_head_name,
                head.employee_id AS department_head_employee_id
            FROM departments dep
            LEFT JOIN users head ON head.id = dep.department_head_id
            WHERE dep.id = ?
            LIMIT 1
            `,
            [id]
        );

        if (departments.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Department not found",
            });
        }

        return res.status(200).json({
            success: true,
            department: departments[0],
        });

    } catch (error) {
        console.error("Get Department Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load department",
        });
    }
};

// ==========================================
// GET DEPARTMENT MEMBERS (paginated)
// ==========================================

const getDepartmentMembers = async (req, res) => {
    try {

        const { id } = req.params;

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM users WHERE department_id = ?`,
            [id]
        );

        const [members] = await pool.query(
            `
            SELECT
                u.id,
                u.employee_id,
                u.full_name,
                u.designation,
                u.employment_type,
                u.employment_status,
                u.reporting_manager_id,
                manager.full_name AS reporting_manager_name
            FROM users u
            LEFT JOIN users manager ON manager.id = u.reporting_manager_id
            WHERE u.department_id = ?
            ORDER BY u.full_name
            LIMIT ? OFFSET ?
            `,
            [id, limit, offset]
        );

        return res.status(200).json({
            success: true,
            members,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });

    } catch (error) {
        console.error("Get Department Members Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load department members",
        });
    }
};

// ==========================================
// CREATE DEPARTMENT
// ==========================================

const createDepartment = async (req, res) => {
    try {

        const { name, code, description } = req.body;

        if (!name?.trim() || !code?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Department name and code are required",
            });
        }

        const cleanedCode = code.trim().toUpperCase();

        const [existing] = await pool.query(
            `SELECT id FROM departments WHERE code = ? LIMIT 1`,
            [cleanedCode]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A department with this code already exists",
            });
        }

        const [result] = await pool.query(
            `
            INSERT INTO departments (name, code, description, status)
            VALUES (?, ?, ?, 'active')
            RETURNING id
            `,
            [name.trim(), cleanedCode, description?.trim() || null]
        );

        return res.status(201).json({
            success: true,
            message: "Department created successfully",
            id: result[0].id,
        });

    } catch (error) {
        console.error("Create Department Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to create department",
        });
    }
};

// ==========================================
// UPDATE DEPARTMENT (name/code/description)
// ==========================================

const updateDepartment = async (req, res) => {
    try {

        const { id } = req.params;
        const { name, code, description } = req.body;

        if (!name?.trim() || !code?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Department name and code are required",
            });
        }

        const cleanedCode = code.trim().toUpperCase();

        const [duplicate] = await pool.query(
            `SELECT id FROM departments WHERE code = ? AND id != ? LIMIT 1`,
            [cleanedCode, id]
        );

        if (duplicate.length > 0) {
            return res.status(409).json({
                success: false,
                message: "A department with this code already exists",
            });
        }

        const [result] = await pool.query(
            `
            UPDATE departments
            SET name = ?, code = ?, description = ?
            WHERE id = ?
            `,
            [name.trim(), cleanedCode, description?.trim() || null, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Department not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Department updated successfully",
        });

    } catch (error) {
        console.error("Update Department Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update department",
        });
    }
};

// ==========================================
// ACTIVATE / DEACTIVATE DEPARTMENT
// Deactivating (not deleting) is the safe way to
// retire a department even if it still has
// active employees — matches the "do not allow
// physical deletion" requirement. There is
// deliberately no delete endpoint at all.
// ==========================================

const setDepartmentStatus = async (req, res) => {
    try {

        const { id } = req.params;
        const { status } = req.body;

        if (!["active", "inactive"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid department status",
            });
        }

        const [result] = await pool.query(
            `UPDATE departments SET status = ? WHERE id = ?`,
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Department not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: `Department ${status === "active" ? "activated" : "deactivated"} successfully`,
        });

    } catch (error) {
        console.error("Set Department Status Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update department status",
        });
    }
};

// ==========================================
// ASSIGN / CHANGE DEPARTMENT HEAD
// Changing the head never touches employment_
// history — only organization_history records it.
// ==========================================

const setDepartmentHead = async (req, res) => {
    try {

        const { id } = req.params;
        const { departmentHeadId } = req.body;

        const [departments] = await pool.query(
            `SELECT id, name, department_head_id FROM departments WHERE id = ? LIMIT 1`,
            [id]
        );

        if (departments.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Department not found",
            });
        }

        const department = departments[0];

        let newHeadId = null;
        let newHeadLabel = "Not assigned";

        if (departmentHeadId) {

            const [heads] = await pool.query(
                `SELECT id, full_name, employee_id, employment_status FROM users WHERE id = ? LIMIT 1`,
                [departmentHeadId]
            );

            if (heads.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "Selected department head not found",
                });
            }

            if (heads[0].employment_status !== "active") {
                return res.status(400).json({
                    success: false,
                    message: "Department head must be an active user",
                });
            }

            newHeadId = heads[0].id;
            newHeadLabel = `${heads[0].full_name} (${heads[0].employee_id})`;

        }

        let oldHeadLabel = "Not assigned";

        if (department.department_head_id) {
            const [oldHeads] = await pool.query(
                `SELECT full_name, employee_id FROM users WHERE id = ? LIMIT 1`,
                [department.department_head_id]
            );
            if (oldHeads.length > 0) {
                oldHeadLabel = `${oldHeads[0].full_name} (${oldHeads[0].employee_id})`;
            }
        }

        await pool.query(
            `UPDATE departments SET department_head_id = ? WHERE id = ?`,
            [newHeadId, id]
        );

        if (newHeadId) {
            await recordOrganizationHistory(pool, {
                userId: newHeadId,
                changeType: "department_head",
                oldValue: `${department.name}: ${oldHeadLabel}`,
                newValue: `${department.name}: ${newHeadLabel}`,
                changedBy: req.user.id,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Department head updated successfully",
        });

    } catch (error) {
        console.error("Set Department Head Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update department head",
        });
    }
};

module.exports = {
    getDepartments,
    getDepartmentById,
    getDepartmentMembers,
    createDepartment,
    updateDepartment,
    setDepartmentStatus,
    setDepartmentHead,
};
