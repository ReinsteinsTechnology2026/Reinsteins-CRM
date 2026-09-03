const bcrypt = require("bcrypt");
const pool = require("./config/db");
require("dotenv").config();

const createEmployee = async () => {
  try {
    const employeeId = "EMP001";
    const fullName = "Test Employee";
    const email = "employee@reinsteins.com";
    const plainPassword = "Employee@123";

    const [existingUsers] = await pool.query(
      `SELECT id
       FROM users
       WHERE employee_id = ? OR email = ?
       LIMIT 1`,
      [employeeId, email]
    );

    if (existingUsers.length > 0) {
      console.log("Employee account already exists.");
      process.exit(0);
    }

    const hashedPassword = await bcrypt.hash(plainPassword, 12);

    await pool.query(
      `INSERT INTO users
       (employee_id, full_name, email, password, role, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        employeeId,
        fullName,
        email,
        hashedPassword,
        "employee",
        "active",
      ]
    );

    console.log("--------------------------------");
    console.log("Employee account created successfully");
    console.log("--------------------------------");
    console.log(`Employee ID: ${employeeId}`);
    console.log(`Email: ${email}`);
    console.log("--------------------------------");

    process.exit(0);
  } catch (error) {
    console.error("Failed to create employee account:");
    console.error(error.message);
    process.exit(1);
  }
};

createEmployee();