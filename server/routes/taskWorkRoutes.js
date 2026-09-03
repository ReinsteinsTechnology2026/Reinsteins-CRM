const express = require("express");

const router = express.Router();

const {

    startWork,

    stopWork

} = require("../controllers/taskWorkController");

const {

    protect

} = require("../middleware/authMiddleware");

const {

    requireActiveUser

} = require("../middleware/accessMiddleware");

// ==========================================
// START WORK
// ==========================================

router.put(

    "/start/:id",

    protect,

    requireActiveUser,

    startWork

);

// ==========================================
// STOP WORK
// ==========================================

router.put(

    "/stop/:id",

    protect,

    requireActiveUser,

    stopWork

);

module.exports = router;