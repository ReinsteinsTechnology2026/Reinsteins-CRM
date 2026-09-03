const bcrypt = require("bcrypt");
const pool = require("./config/db");
require("dotenv").config();

const createAdmin = async () => {
  try {
    const employeeId = "Shafiq20";
    const fullName = "System Administrator";
    const email = "admin@reinsteins.com";
    const plainPassword = "Shafiq@123";

    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE employee_id = ? OR email = ?",
      [employeeId, email]
    );

    if (existingUsers.length > 0) {
      console.log("Admin account already exists.");
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
        "admin",
        "active",
      ]
    );

    console.log("--------------------------------");
    console.log("Admin account created successfully");
    console.log("--------------------------------");
    console.log(`Employee ID: ${employeeId}`);
    console.log(`Email: ${email}`);
    console.log("--------------------------------");

    process.exit(0);
  } catch (error) {
    console.error("Failed to create admin account:");
    console.error(error.message);
    process.exit(1);
  }
};

createAdmin();