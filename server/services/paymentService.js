const platformPool = require("../config/platformDb");

// ==========================================
// PAYMENT SERVICE (Phase 10B)
//
// Pure DB logic against groworgs_platform_db.payments ONLY -- same
// layering convention as platformCompanyService.js/
// subscriptionPlanService.js. Never touches a tenant database, never
// touches card/bank data (there is no column for it -- see
// _migrate_add_payments.js). Controllers never write raw SQL for
// payments; everything goes through here.
// ==========================================

const PAYMENT_COLUMNS = `
    id, company_id, plan_id, amount, currency, billing_cycle, payment_status,
    payment_provider, provider_payment_id, provider_order_id, invoice_number,
    notes, paid_at, created_at, updated_at
`;

// Same columns, explicitly p.-prefixed for the JOINed listPayments
// query below (unambiguous once `companies`/`subscription_plans` are
// joined in, since a couple of column names could otherwise collide).
const PAYMENT_COLUMNS_PREFIXED = `
    p.id, p.company_id, p.plan_id, p.amount, p.currency, p.billing_cycle, p.payment_status,
    p.payment_provider, p.provider_payment_id, p.provider_order_id, p.invoice_number,
    p.notes, p.paid_at, p.created_at, p.updated_at
`;

const VALID_STATUSES = ["pending", "paid", "failed", "refunded", "cancelled"];
const VALID_BILLING_CYCLES = ["monthly", "yearly", "one_time"];

const getPaymentById = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

const getPaymentByProviderPaymentId = async (providerPaymentId) => {
    const [rows] = await platformPool.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider_payment_id = ? LIMIT 1`,
        [providerPaymentId]
    );
    return rows[0] || null;
};

// Phase 11H (webhook processing) needs to find a payment by the
// Razorpay order id a webhook event references -- provider_payment_id
// isn't known yet at that point (that's precisely what the event is
// reporting for the first time).
const getPaymentByProviderOrderId = async (providerOrderId) => {
    const [rows] = await platformPool.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE provider_order_id = ? LIMIT 1`,
        [providerOrderId]
    );
    return rows[0] || null;
};

// Generates a simple, sequential, human-readable invoice number --
// only ever called at the moment a payment actually becomes 'paid'
// (see updatePaymentStatus below), never speculatively for a pending
// or failed record. Format: INV-<year>-<zero-padded id>, e.g.
// INV-2026-000042. Using the row's own auto-increment id keeps this
// collision-free without a separate counter table.
const buildInvoiceNumber = (paymentId) => {
    const year = new Date().getFullYear();
    return `INV-${year}-${String(paymentId).padStart(6, "0")}`;
};

// Creates a payment row in a known, valid state. Every field here is
// either server-validated by the caller (platformPaymentController.js)
// or server-generated (id, timestamps) -- nothing from a request body
// reaches this function unvalidated.
const createPaymentRecord = async ({
    companyId, planId, amount, currency, billingCycle, paymentStatus,
    paymentProvider, providerPaymentId, providerOrderId, notes,
}) => {
    try {

        const [result] = await platformPool.query(
            `INSERT INTO payments
                (company_id, plan_id, amount, currency, billing_cycle, payment_status,
                 payment_provider, provider_payment_id, provider_order_id, notes,
                 paid_at, invoice_number)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
            [
                companyId, planId, amount, currency, billingCycle, paymentStatus,
                paymentProvider || null, providerPaymentId || null, providerOrderId || null, notes || null,
                paymentStatus === "paid" ? new Date() : null,
                null, // invoice number assigned below, after we have a real id
            ]
        );

        let invoiceNumber = null;
        if (paymentStatus === "paid") {
            invoiceNumber = buildInvoiceNumber(result.insertId);
            await platformPool.query(`UPDATE payments SET invoice_number = ? WHERE id = ?`, [invoiceNumber, result.insertId]);
        }

        return await getPaymentById(result.insertId);

    } catch (dbError) {
        // PostgreSQL SQLSTATE codes (this project's compat pool runs
        // against PostgreSQL -- see config/pgCompat.js): 23505 =
        // unique_violation, 23503 = foreign_key_violation. PostgreSQL
        // uses the SAME code for both "referenced row missing" and
        // "row still referenced" FK failures, unlike MySQL's two
        // distinct codes.
        if (dbError.code === "23505") {
            const error = new Error("A payment with this provider payment ID already exists.");
            error.code = "PAYMENT_DUPLICATE";
            throw error;
        }
        if (dbError.code === "23503") {
            const error = new Error("Invalid company or plan reference.");
            error.code = "PAYMENT_INVALID_REFERENCE";
            throw error;
        }
        throw dbError;
    }
};

// Guarded, idempotent status transition -- assigns an invoice number
// exactly once, only on the transition INTO 'paid' (never
// re-generates or overwrites an existing invoice number on a later
// update, and never assigns one for any other status). Calling this
// twice with the same target status is a safe no-op on the invoice
// number/paid_at fields (both stay as first set).
const updatePaymentStatus = async (id, newStatus) => {

    const existing = await getPaymentById(id);
    if (!existing) return null;

    const paidAt = newStatus === "paid" ? (existing.paid_at || new Date()) : existing.paid_at;

    await platformPool.query(
        `UPDATE payments SET payment_status = ?, paid_at = ? WHERE id = ?`,
        [newStatus, paidAt, id]
    );

    // Assign an invoice number the FIRST time (and only the first
    // time) a payment becomes 'paid' -- a payment that later gets
    // refunded/cancelled keeps its original invoice number (the
    // invoice for what was actually paid), it is not deleted or
    // reassigned.
    if (newStatus === "paid" && !existing.invoice_number) {
        const invoiceNumber = buildInvoiceNumber(id);
        await platformPool.query(`UPDATE payments SET invoice_number = ? WHERE id = ?`, [invoiceNumber, id]);
    }

    return await getPaymentById(id);
};

// Full list with optional filters -- every filter is applied as a
// parameterized WHERE clause, never string-concatenated. Company
// isolation is structural: a company filter is just an extra WHERE
// term over this one shared table (Platform Owner sees all companies
// by design), not a cross-tenant query of any kind -- this table
// lives in groworgs_platform_db, not any tenant database.
const listPayments = async ({ status, companyId, search, dateFrom, dateTo, sortBy } = {}) => {

    const conditions = [];
    const params = [];

    if (status) {
        conditions.push(`p.payment_status = ?`);
        params.push(status);
    }
    if (companyId) {
        conditions.push(`p.company_id = ?`);
        params.push(companyId);
    }
    if (dateFrom) {
        conditions.push(`p.created_at >= ?`);
        params.push(dateFrom);
    }
    if (dateTo) {
        conditions.push(`p.created_at <= ?`);
        params.push(dateTo);
    }
    if (search) {
        conditions.push(`(p.invoice_number LIKE ? OR c.company_name LIKE ? OR c.company_slug LIKE ?)`);
        const term = `%${search}%`;
        params.push(term, term, term);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sortMap = {
        newest: "p.created_at DESC",
        oldest: "p.created_at ASC",
        amount_high: "p.amount DESC",
        amount_low: "p.amount ASC",
    };
    const orderClause = sortMap[sortBy] || sortMap.newest;

    const [rows] = await platformPool.query(
        `SELECT ${PAYMENT_COLUMNS_PREFIXED},
                c.company_name, c.company_slug, sp.name AS plan_name
         FROM payments p
         JOIN companies c ON c.id = p.company_id
         JOIN subscription_plans sp ON sp.id = p.plan_id
         ${whereClause}
         ORDER BY ${orderClause}`,
        params
    );

    return rows;
};

const getCompanyPayments = async (companyId) => listPayments({ companyId, sortBy: "newest" });

// Phase 11C -- records the Razorpay order id created for a pending
// payment. Never touches payment_status or any other field; the order
// existing is not the same thing as the order being paid.
const setProviderOrderId = async (id, providerOrderId) => {
    await platformPool.query(`UPDATE payments SET provider_order_id = ? WHERE id = ?`, [providerOrderId, id]);
    return await getPaymentById(id);
};

// Phase 11E/11H -- the ONE place a payment is ever transitioned to
// 'paid' as a result of a verified Razorpay payment (called from both
// the verify endpoint and the webhook handler, so there is exactly one
// implementation of "what does becoming paid actually do" to keep
// correct). Guarded exactly like updatePaymentStatus's WHERE clause
// convention, but additionally reports whether THIS call was the one
// that performed the transition -- callers (finalizePaymentSuccess in
// the controller) need that to avoid re-running subscription
// activation on an idempotent duplicate call/race, which would
// otherwise silently double-extend a company's paid access.
const markPaymentPaid = async (id, { providerPaymentId }) => {

    const existing = await getPaymentById(id);
    if (!existing) return { payment: null, alreadyPaid: false };
    if (existing.payment_status === "paid") return { payment: existing, alreadyPaid: true };

    let result;
    try {
        [result] = await platformPool.query(
            `UPDATE payments SET payment_status = 'paid', provider_payment_id = ?, paid_at = COALESCE(paid_at, NOW())
             WHERE id = ? AND payment_status = 'pending'`,
            [providerPaymentId, id]
        );
    } catch (dbError) {
        if (dbError.code === "23505") {
            const error = new Error("This Razorpay payment ID has already been recorded against a different payment.");
            error.code = "PAYMENT_DUPLICATE";
            throw error;
        }
        throw dbError;
    }

    if (result.affectedRows === 0) {
        // Lost a race to a concurrent call (webhook vs. frontend verify
        // arriving at nearly the same time), or the payment moved out of
        // 'pending' some other way in between -- either way, report the
        // CURRENT state as already-handled rather than reprocessing.
        return { payment: await getPaymentById(id), alreadyPaid: true };
    }

    let updated = await getPaymentById(id);
    if (!updated.invoice_number) {
        const invoiceNumber = buildInvoiceNumber(id);
        await platformPool.query(`UPDATE payments SET invoice_number = ? WHERE id = ?`, [invoiceNumber, id]);
        updated = await getPaymentById(id);
    }

    return { payment: updated, alreadyPaid: false };
};

// Pure aggregation -- COUNTs and a SUM over payment_status = 'paid'
// ONLY. This is the one and only place "revenue" is computed
// anywhere in this codebase; every UI that shows a revenue number
// reads it from here (directly or via the dashboard's reuse of it),
// so there is exactly one definition of "revenue" to ever be wrong.
const getPaymentStats = async () => {

    const [statusRows] = await platformPool.query(
        `SELECT payment_status, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total
         FROM payments GROUP BY payment_status`
    );

    const stats = {
        totalPayments: 0,
        paid: 0,
        pending: 0,
        failed: 0,
        refunded: 0,
        cancelled: 0,
        totalRevenue: 0,
    };

    for (const row of statusRows) {
        const count = Number(row.c);
        stats.totalPayments += count;
        stats[row.payment_status] = count;
        if (row.payment_status === "paid") {
            stats.totalRevenue = Number(row.total);
        }
    }

    // Revenue by month -- only over PAID payments, grouped by their
    // real paid_at timestamp (not created_at, so a payment recorded
    // as pending today and marked paid next month counts toward the
    // month it was actually paid).
    const [monthlyRows] = await platformPool.query(
        `SELECT TO_CHAR(paid_at, 'YYYY-MM') AS month, COALESCE(SUM(amount), 0) AS total
         FROM payments WHERE payment_status = 'paid' AND paid_at IS NOT NULL
         GROUP BY month ORDER BY month ASC`
    );
    const revenueByMonth = monthlyRows.map((r) => ({ month: r.month, total: Number(r.total) }));

    // Monthly vs yearly plan revenue split -- paid payments only.
    const [cycleRows] = await platformPool.query(
        `SELECT billing_cycle, COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total
         FROM payments WHERE payment_status = 'paid' GROUP BY billing_cycle`
    );
    const revenueByBillingCycle = cycleRows.map((r) => ({
        billingCycle: r.billing_cycle, count: Number(r.c), total: Number(r.total),
    }));

    // Plan revenue distribution -- paid payments only, joined to the
    // plan's current name (a plan is never deleted, only
    // enabled/disabled -- see subscriptionPlanService.js -- so this
    // join can never silently drop a row for a "missing" plan).
    const [planRows] = await platformPool.query(
        `SELECT sp.id AS plan_id, sp.name AS plan_name, COUNT(*) AS c, COALESCE(SUM(p.amount), 0) AS total
         FROM payments p JOIN subscription_plans sp ON sp.id = p.plan_id
         WHERE p.payment_status = 'paid'
         GROUP BY sp.id, sp.name ORDER BY total DESC`
    );
    const revenueByPlan = planRows.map((r) => ({
        planId: r.plan_id, planName: r.plan_name, count: Number(r.c), total: Number(r.total),
    }));

    return { ...stats, revenueByMonth, revenueByBillingCycle, revenueByPlan };
};

module.exports = {
    VALID_STATUSES,
    VALID_BILLING_CYCLES,
    getPaymentById,
    getPaymentByProviderPaymentId,
    getPaymentByProviderOrderId,
    createPaymentRecord,
    updatePaymentStatus,
    setProviderOrderId,
    markPaymentPaid,
    listPayments,
    getCompanyPayments,
    getPaymentStats,
};
