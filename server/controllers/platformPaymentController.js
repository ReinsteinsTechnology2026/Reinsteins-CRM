const paymentService = require("../services/paymentService");
const platformCompanyService = require("../services/platformCompanyService");
const subscriptionPlanService = require("../services/subscriptionPlanService");
const subscriptionLifecycleService = require("../services/subscriptionLifecycleService");
const platformAuditService = require("../services/platformAuditService");
const { getProvider } = require("../paymentProviders/paymentProviderFactory");

// ==========================================
// PLATFORM PAYMENT CONTROLLER (Phase 10C)
//
// Every route using this controller is mounted behind platformProtect
// -- only an authenticated, active Platform Owner ever reaches these
// handlers (the one exception is the webhook route, which is NOT
// mounted behind platformProtect at all -- webhooks come from the
// payment gateway's servers, not a logged-in Platform Owner, and
// authenticate via signature instead; see handleRazorpayWebhook and
// its own comment).
//
// No real payment gateway is active yet (see paymentProviders/). The
// only way a payment row is created today is the Platform Owner
// manually recording one (an offline/bank-transfer payment, a very
// ordinary real feature in B2B SaaS billing) -- createPayment below
// unconditionally forces payment_provider='manual' and both provider
// ID fields to null, REGARDLESS of what the request body contains,
// so a client can never claim an unverified "razorpay" transaction
// happened. Once Razorpay is actually wired up, real provider-created
// payments will go through a separate verify-then-record path (order
// creation -> checkout -> verifyPaymentSignature -> only THEN does a
// provider payment id get stored) that doesn't exist yet by design.
// ==========================================

const MAX_AMOUNT = 10000000;

const toSafePayment = (row) => ({
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    companySlug: row.company_slug,
    planId: row.plan_id,
    planName: row.plan_name,
    amount: Number(row.amount),
    currency: row.currency,
    billingCycle: row.billing_cycle,
    paymentStatus: row.payment_status,
    paymentProvider: row.payment_provider,
    providerPaymentId: row.provider_payment_id,
    providerOrderId: row.provider_order_id,
    invoiceNumber: row.invoice_number,
    notes: row.notes,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ==========================================
// RAZORPAY CHECKOUT FLOW (Phase 11)
//
// Reuses every Phase 10 building block (paymentService, subscription-
// PlanService, platformCompanyService.updateCompanySubscription) --
// nothing here duplicates a table, a service, or the manual-payment
// path above. The only genuinely new pieces are: computing a
// subscription's next expiry date, and finalizePaymentSuccess() --
// the single shared "what does becoming paid actually do" function
// used by BOTH the verify endpoint and the webhook handler, so a
// payment can never be activated twice no matter which of the two
// confirms it first.
// ==========================================

const BILLING_CYCLE_MONTHS = { monthly: 1, yearly: 12 };

// Pure date math, server-side only -- never derived from anything the
// client sends. A payment recorded as 'one_time' has no subscription-
// period semantics in this architecture, so it intentionally does NOT
// go through this function (see finalizePaymentSuccess).
function computeSubscriptionExpiry(billingCycle, from = new Date()) {
    const expires = new Date(from);
    if (billingCycle === "yearly") {
        expires.setFullYear(expires.getFullYear() + 1);
    } else {
        expires.setMonth(expires.getMonth() + 1);
    }
    return expires;
}

// The ONE place a verified/webhook-confirmed payment becomes 'paid'
// AND (for monthly/yearly payments) activates the company's
// subscription. Idempotent by construction: paymentService.markPaymentPaid
// reports whether IT actually performed the pending->paid transition
// (vs. finding the payment already paid, e.g. a duplicate webhook
// arriving after the frontend's verify call already succeeded) --
// subscription activation only ever runs on that first, real
// transition, never on a repeat/duplicate confirmation. This is what
// prevents a payment from ever extending a company's access twice.
async function finalizePaymentSuccess(paymentId, providerPaymentId) {
    const { payment: updated, alreadyPaid } = await paymentService.markPaymentPaid(paymentId, { providerPaymentId });
    if (!updated) {
        return { payment: null, subscriptionActivated: false };
    }
    if (alreadyPaid) {
        return { payment: updated, subscriptionActivated: false };
    }

    let subscriptionActivated = false;
    if (BILLING_CYCLE_MONTHS[updated.billing_cycle]) {
        const company = await platformCompanyService.getCompanyById(updated.company_id);
        // Guard, not a normal path: only reachable if the company was
        // deleted between order creation and payment confirmation.
        if (company && (company.status === "active" || company.status === "suspended")) {
            const subscriptionExpiresAt = computeSubscriptionExpiry(updated.billing_cycle);
            await platformCompanyService.updateCompanySubscription(company.id, {
                planId: updated.plan_id,
                subscriptionStatus: "active",
                // Deliberately left untouched -- isCompanyAccessAllowed only
                // consults trial_ends_at while subscription_status is
                // 'trial'; once it's 'active' this field is inert, so there
                // is nothing to "clean up" and nothing gained by rewriting
                // it (see platformCompanyService.isCompanyAccessAllowed).
                trialEndsAt: company.trial_ends_at,
                subscriptionExpiresAt,
            });
            subscriptionActivated = true;

            // Phase 12I -- history logging, grace-period clearing, and
            // owner/company notification for the renewal. `company` here
            // is deliberately the row fetched BEFORE the update above
            // (the true "previous" state) -- subscriptionLifecycleService
            // never re-derives it, avoiding a second, possibly
            // inconsistent read. Best-effort: never allowed to undo or
            // block the activation that already committed above.
            try {
                await subscriptionLifecycleService.processRenewalSuccess({
                    company, payment: updated, previousStatus: company.subscription_status, previousPlanId: company.plan_id,
                });
            } catch (lifecycleError) {
                console.error(`[platform] processRenewalSuccess failed for payment ${paymentId}:`, lifecycleError.message);
            }
        }
    }

    return { payment: await paymentService.getPaymentById(paymentId), subscriptionActivated };
}

// POST /payments/checkout -- Platform Owner initiates a real Razorpay
// checkout for a company + plan + billing cycle. Creates the pending
// payment row (reusing paymentService.createPaymentRecord -- the same
// function the manual-recording path uses) and, unlike that path,
// immediately creates a real Razorpay order for it. The amount is
// ALWAYS derived from the plan's own stored price, never from the
// request body -- there is no "amount" field this endpoint even reads
// from the client.
const createCheckoutPayment = async (req, res) => {
    try {
        const companyId = Number(req.body?.companyId);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "A valid companyId is required." });
        }

        const planId = Number(req.body?.planId);
        if (!Number.isInteger(planId) || planId <= 0) {
            return res.status(400).json({ success: false, message: "A valid planId is required." });
        }

        const billingCycle = req.body?.billingCycle;
        if (!BILLING_CYCLE_MONTHS[billingCycle]) {
            return res.status(400).json({ success: false, message: "billingCycle must be 'monthly' or 'yearly' for a subscription checkout." });
        }

        const company = await platformCompanyService.getCompanyById(companyId);
        if (!company || !["active", "suspended"].includes(company.status)) {
            return res.status(400).json({ success: false, message: "Company not found or not yet provisioned." });
        }

        const plan = await subscriptionPlanService.getPlanById(planId);
        if (!plan || plan.status !== "active") {
            return res.status(400).json({ success: false, message: "Invalid or disabled plan." });
        }

        const priceField = billingCycle === "yearly" ? "yearly_price" : "monthly_price";
        const amount = plan[priceField] !== null && plan[priceField] !== undefined ? Number(plan[priceField]) : null;
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, message: `This plan does not have a ${billingCycle} price configured.` });
        }

        const payment = await paymentService.createPaymentRecord({
            companyId, planId, amount, currency: "INR", billingCycle,
            paymentStatus: "pending",
            paymentProvider: "razorpay",
            providerPaymentId: null,
            providerOrderId: null,
            notes: null,
        });

        const orderResult = await createRazorpayOrderForPayment(payment);
        if (orderResult.error) {
            // The pending payment row still exists -- nothing was lost,
            // and POST /payments/:id/create-order can retry it once the
            // gateway is configured/reachable.
            return res.status(orderResult.status).json({
                success: false,
                message: orderResult.message,
                payment: toSafePayment({ ...payment, company_name: company.company_name, company_slug: company.company_slug, plan_name: plan.name }),
            });
        }

        return res.status(201).json({
            success: true,
            payment: toSafePayment({ ...orderResult.payment, company_name: company.company_name, company_slug: company.company_slug, plan_name: plan.name }),
            razorpay: { orderId: orderResult.orderId, keyId: process.env.RAZORPAY_KEY_ID, amount: orderResult.amountInSmallestUnit, currency: "INR" },
        });

    } catch (error) {
        console.error("[platform] createCheckoutPayment failed:", error);
        return res.status(500).json({ success: false, message: "Failed to start checkout." });
    }
};

// POST /payments/:id/create-order -- (re)creates a Razorpay order for
// an EXISTING pending Razorpay payment (e.g. the first order-creation
// attempt failed, or the Platform Owner is retrying after closing the
// checkout modal). If an order already exists for this payment, it is
// reused rather than creating a second one against the same payment
// row -- Razorpay orders remain payable until paid, so there is never
// a need for more than one live order per pending payment.
const createOrderForExistingPayment = async (req, res) => {
    try {
        const paymentId = Number(req.params.id);
        if (!Number.isInteger(paymentId) || paymentId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid payment id." });
        }

        const payment = await paymentService.getPaymentById(paymentId);
        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found." });
        }
        if (payment.payment_provider !== "razorpay") {
            return res.status(400).json({ success: false, message: "This payment does not use Razorpay." });
        }
        if (payment.payment_status !== "pending") {
            return res.status(409).json({ success: false, message: `This payment is already ${payment.payment_status} and cannot create a new order.` });
        }

        const [company, plan] = await Promise.all([
            platformCompanyService.getCompanyById(payment.company_id),
            subscriptionPlanService.getPlanById(payment.plan_id),
        ]);

        if (payment.provider_order_id) {
            return res.status(200).json({
                success: true,
                payment: toSafePayment({ ...payment, company_name: company?.company_name, company_slug: company?.company_slug, plan_name: plan?.name }),
                razorpay: {
                    orderId: payment.provider_order_id,
                    keyId: process.env.RAZORPAY_KEY_ID,
                    amount: Math.round(Number(payment.amount) * 100),
                    currency: payment.currency,
                },
            });
        }

        const orderResult = await createRazorpayOrderForPayment(payment);
        if (orderResult.error) {
            return res.status(orderResult.status).json({ success: false, message: orderResult.message });
        }

        return res.status(201).json({
            success: true,
            payment: toSafePayment({ ...orderResult.payment, company_name: company?.company_name, company_slug: company?.company_slug, plan_name: plan?.name }),
            razorpay: { orderId: orderResult.orderId, keyId: process.env.RAZORPAY_KEY_ID, amount: orderResult.amountInSmallestUnit, currency: payment.currency },
        });

    } catch (error) {
        console.error("[platform] createOrderForExistingPayment failed:", error);
        return res.status(500).json({ success: false, message: "Failed to create order." });
    }
};

// Shared by both order-creation endpoints above -- the ONE place that
// actually calls Razorpay to create an order and persists the
// resulting id. Amount is converted to paise (Razorpay's smallest-unit
// contract for INR) via Math.round(), never raw float multiplication
// left un-rounded -- payment.amount is a DECIMAL(10,2) that can arrive
// here as e.g. 4999.9999999996 after floating-point multiplication by
// 100, and Math.round() is what makes that land on the correct integer
// paise value instead of silently truncating a paisa off real money.
async function createRazorpayOrderForPayment(payment) {
    const provider = getProvider("razorpay");
    const amountInSmallestUnit = Math.round(Number(payment.amount) * 100);

    try {
        const order = await provider.createOrder({
            amountInSmallestUnit,
            currency: payment.currency,
            receipt: `payment_${payment.id}`,
        });
        const updatedPayment = await paymentService.setProviderOrderId(payment.id, order.id);
        return { error: false, orderId: order.id, amountInSmallestUnit, payment: updatedPayment };
    } catch (providerError) {
        if (providerError.code === "PROVIDER_NOT_CONFIGURED") {
            return { error: true, status: 503, message: "Razorpay is not configured yet. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable checkout." };
        }
        console.error("[platform] Razorpay order creation failed:", providerError.message);
        return { error: true, status: 502, message: "Razorpay did not accept the order request. Please try again." };
    }
}

// POST /payments/:id/verify -- the ONLY path that can ever transition
// a Razorpay payment to 'paid' from the frontend side. The backend
// recomputes and checks everything itself; nothing about "did this
// payment succeed" is ever taken on the client's word.
const verifyPayment = async (req, res) => {
    try {
        const paymentId = Number(req.params.id);
        if (!Number.isInteger(paymentId) || paymentId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid payment id." });
        }

        const payment = await paymentService.getPaymentById(paymentId);
        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found." });
        }
        if (payment.payment_provider !== "razorpay") {
            return res.status(400).json({ success: false, message: "This payment does not use Razorpay." });
        }

        // Idempotent short-circuit -- a browser refresh/retry after a
        // successful verification (or a webhook that already confirmed
        // it first) must return the same success response, never attempt
        // to re-verify or re-activate anything.
        if (payment.payment_status === "paid") {
            const [company, plan] = await Promise.all([
                platformCompanyService.getCompanyById(payment.company_id),
                subscriptionPlanService.getPlanById(payment.plan_id),
            ]);
            return res.status(200).json({
                success: true,
                alreadyVerified: true,
                payment: toSafePayment({ ...payment, company_name: company?.company_name, company_slug: company?.company_slug, plan_name: plan?.name }),
            });
        }
        if (payment.payment_status !== "pending") {
            return res.status(409).json({ success: false, message: `This payment is ${payment.payment_status} and cannot be verified.` });
        }

        const razorpayOrderId = req.body?.razorpayOrderId;
        const razorpayPaymentId = req.body?.razorpayPaymentId;
        const razorpaySignature = req.body?.razorpaySignature;
        if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return res.status(400).json({ success: false, message: "razorpayOrderId, razorpayPaymentId, and razorpaySignature are all required." });
        }

        if (!payment.provider_order_id || razorpayOrderId !== payment.provider_order_id) {
            return res.status(400).json({ success: false, message: "Order ID does not match this payment." });
        }

        const provider = getProvider("razorpay");
        let signatureValid;
        try {
            signatureValid = provider.verifyPaymentSignature({
                orderId: payment.provider_order_id,
                paymentId: razorpayPaymentId,
                signature: razorpaySignature,
            });
        } catch (providerError) {
            if (providerError.code === "PROVIDER_NOT_CONFIGURED") {
                return res.status(503).json({ success: false, message: "Razorpay is not configured yet." });
            }
            throw providerError;
        }

        if (!signatureValid) {
            console.warn(`[platform] Payment ${paymentId}: signature verification failed -- rejected, status left unchanged.`);
            return res.status(400).json({ success: false, message: "Payment signature verification failed." });
        }

        let result;
        try {
            result = await finalizePaymentSuccess(paymentId, razorpayPaymentId);
        } catch (finalizeError) {
            if (finalizeError.code === "PAYMENT_DUPLICATE") {
                return res.status(409).json({ success: false, message: finalizeError.message });
            }
            throw finalizeError;
        }

        const [company, plan] = await Promise.all([
            platformCompanyService.getCompanyById(result.payment.company_id),
            subscriptionPlanService.getPlanById(result.payment.plan_id),
        ]);

        return res.status(200).json({
            success: true,
            subscriptionActivated: result.subscriptionActivated,
            payment: toSafePayment({ ...result.payment, company_name: company?.company_name, company_slug: company?.company_slug, plan_name: plan?.name }),
        });

    } catch (error) {
        console.error("[platform] verifyPayment failed:", error);
        return res.status(500).json({ success: false, message: "Payment verification failed." });
    }
};

const listPayments = async (req, res) => {
    try {
        const { status, companyId, search, dateFrom, dateTo, sortBy } = req.query;

        if (status && !paymentService.VALID_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status filter." });
        }

        let companyIdNum;
        if (companyId !== undefined) {
            companyIdNum = Number(companyId);
            if (!Number.isInteger(companyIdNum) || companyIdNum <= 0) {
                return res.status(400).json({ success: false, message: "Invalid companyId filter." });
            }
        }

        const rows = await paymentService.listPayments({
            status: status || undefined,
            companyId: companyIdNum,
            search: typeof search === "string" ? search.trim() : undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            sortBy: sortBy || undefined,
        });

        return res.status(200).json({ success: true, payments: rows.map(toSafePayment) });
    } catch (error) {
        console.error("[platform] listPayments failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load payments." });
    }
};

const getPaymentStats = async (_req, res) => {
    try {
        const stats = await paymentService.getPaymentStats();
        return res.status(200).json({ success: true, stats });
    } catch (error) {
        console.error("[platform] getPaymentStats failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load payment stats." });
    }
};

const getPaymentDetails = async (req, res) => {
    try {
        const paymentId = Number(req.params.id);
        if (!Number.isInteger(paymentId) || paymentId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid payment id." });
        }

        const payment = await paymentService.getPaymentById(paymentId);
        if (!payment) {
            return res.status(404).json({ success: false, message: "Payment not found." });
        }

        // getPaymentById doesn't join company/plan names (listPayments
        // does) -- fetch them here so the details view has the same
        // display fields without a second network round trip.
        const [company, plan] = await Promise.all([
            platformCompanyService.getCompanyById(payment.company_id),
            subscriptionPlanService.getPlanById(payment.plan_id),
        ]);

        return res.status(200).json({
            success: true,
            payment: toSafePayment({
                ...payment,
                company_name: company?.company_name || null,
                company_slug: company?.company_slug || null,
                plan_name: plan?.name || null,
            }),
        });
    } catch (error) {
        console.error("[platform] getPaymentDetails failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load payment." });
    }
};

// Manual payment recording -- see module header. This is the ONLY
// creation path today; payment_provider/provider_payment_id/
// provider_order_id are never taken from the request body.
const createPayment = async (req, res) => {
    try {
        const companyId = Number(req.body?.companyId);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ success: false, message: "A valid companyId is required." });
        }

        const planId = Number(req.body?.planId);
        if (!Number.isInteger(planId) || planId <= 0) {
            return res.status(400).json({ success: false, message: "A valid planId is required." });
        }

        const amount = Number(req.body?.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
            return res.status(400).json({ success: false, message: `amount must be a positive number up to ${MAX_AMOUNT}.` });
        }

        const currency = (req.body?.currency || "INR").toUpperCase();
        if (!CURRENCY_PATTERN.test(currency)) {
            return res.status(400).json({ success: false, message: "currency must be a 3-letter code (e.g. INR, USD)." });
        }

        const billingCycle = req.body?.billingCycle;
        if (!paymentService.VALID_BILLING_CYCLES.includes(billingCycle)) {
            return res.status(400).json({
                success: false,
                message: `billingCycle must be one of: ${paymentService.VALID_BILLING_CYCLES.join(", ")}.`,
            });
        }

        // Only these two are meaningful for a manually-recorded entry
        // -- 'failed'/'refunded'/'cancelled' only make sense as a
        // LATER transition (via updatePaymentStatus) on a payment that
        // already existed, never as the very first state of one the
        // Platform Owner is entering by hand.
        const paymentStatus = req.body?.paymentStatus === "paid" ? "paid" : "pending";

        const notesRaw = req.body?.notes;
        if (notesRaw !== undefined && notesRaw !== null && typeof notesRaw !== "string") {
            return res.status(400).json({ success: false, message: "notes must be a string." });
        }
        if (typeof notesRaw === "string" && notesRaw.length > 500) {
            return res.status(400).json({ success: false, message: "notes must be 500 characters or fewer." });
        }

        const company = await platformCompanyService.getCompanyById(companyId);
        if (!company || !["active", "suspended"].includes(company.status)) {
            return res.status(400).json({ success: false, message: "Company not found or not yet provisioned." });
        }

        const plan = await subscriptionPlanService.getPlanById(planId);
        if (!plan) {
            return res.status(400).json({ success: false, message: "Invalid plan id." });
        }

        const payment = await paymentService.createPaymentRecord({
            companyId,
            planId,
            amount,
            currency,
            billingCycle,
            paymentStatus,
            paymentProvider: "manual",
            providerPaymentId: null,
            providerOrderId: null,
            notes: typeof notesRaw === "string" ? notesRaw.trim() : null,
        });

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "payment_recorded", targetType: "payment", targetId: payment.id, companyId,
            metadata: { amount: payment.amount, currency: payment.currency, billingCycle: payment.billing_cycle, paymentStatus: payment.payment_status },
        }).catch((auditError) => console.error("[platform] audit log failed (payment_recorded):", auditError.message));

        return res.status(201).json({
            success: true,
            payment: toSafePayment({ ...payment, company_name: company.company_name, company_slug: company.company_slug, plan_name: plan.name }),
        });
    } catch (error) {
        if (error.code === "PAYMENT_DUPLICATE") {
            return res.status(409).json({ success: false, message: error.message });
        }
        console.error("[platform] createPayment failed:", error);
        return res.status(500).json({ success: false, message: "Failed to record payment." });
    }
};

const updatePaymentStatus = async (req, res) => {
    try {
        const paymentId = Number(req.params.id);
        if (!Number.isInteger(paymentId) || paymentId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid payment id." });
        }

        const status = req.body?.status;
        if (!paymentService.VALID_STATUSES.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `status must be one of: ${paymentService.VALID_STATUSES.join(", ")}.`,
            });
        }

        // Phase 11 security requirement: a Razorpay payment must only
        // ever become 'paid' through POST /payments/:id/verify (real
        // signature check) or a signature-verified webhook -- never
        // through this generic manual-status endpoint, which would
        // otherwise let anyone with Platform Owner access flip a
        // Razorpay payment to 'paid' with no verification at all. This
        // does not affect manual payments (payment_provider = 'manual'
        // or null), which continue to use this endpoint exactly as in
        // Phase 10.
        if (status === "paid") {
            const existing = await paymentService.getPaymentById(paymentId);
            if (existing?.payment_provider === "razorpay") {
                return res.status(400).json({
                    success: false,
                    message: "Razorpay payments can only be marked paid through payment verification, not manually.",
                });
            }
        }

        const updated = await paymentService.updatePaymentStatus(paymentId, status);
        if (!updated) {
            return res.status(404).json({ success: false, message: "Payment not found." });
        }

        const [company, plan] = await Promise.all([
            platformCompanyService.getCompanyById(updated.company_id),
            subscriptionPlanService.getPlanById(updated.plan_id),
        ]);

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "payment_status_changed", targetType: "payment", targetId: updated.id, companyId: updated.company_id,
            metadata: { newStatus: status },
        }).catch((auditError) => console.error("[platform] audit log failed (payment_status_changed):", auditError.message));

        // Phase 12H -- any payment (manual or Razorpay) becoming
        // 'failed' is a real lifecycle event worth logging/notifying
        // about, regardless of provider. Deliberately best-effort and
        // never blocks the status-change response that already
        // committed above.
        if (status === "failed" && company) {
            await subscriptionLifecycleService.processPaymentFailure({ company, payment: updated }).catch((lifecycleError) => {
                console.error(`[platform] processPaymentFailure failed for payment ${updated.id}:`, lifecycleError.message);
            });
        }

        return res.status(200).json({
            success: true,
            payment: toSafePayment({ ...updated, company_name: company?.company_name || null, company_slug: company?.company_slug || null, plan_name: plan?.name || null }),
        });
    } catch (error) {
        console.error("[platform] updatePaymentStatus failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update payment status." });
    }
};

// ==========================================
// WEBHOOK (Phase 10H -- architecture preparation, not activated)
//
// POST /api/platform/payments/webhook/razorpay -- deliberately NOT
// mounted behind platformProtect (see routes/platformPaymentRoutes.js):
// a webhook call comes from Razorpay's own servers, which have no
// Platform Owner JWT and never will. Authentication here is the
// signature check below instead -- exactly the same trust model a
// JWT provides, just a different mechanism suited to server-to-server
// calls with no logged-in user.
//
// Requires RAZORPAY_WEBHOOK_SECRET to be configured; since it isn't
// in this deployment, every call to this route today returns 503
// "not configured" and writes nothing -- it cannot be tricked into
// creating or updating a payment record no matter what body is sent,
// which is the whole point of "do not implement an insecure payment-
// successful endpoint".
//
// Idempotency: reuses the exact same finalizePaymentSuccess() the
// verify endpoint uses, which itself relies on paymentService.
// markPaymentPaid()'s guarded `WHERE payment_status = 'pending'`
// transition -- if the frontend's verify call (or an earlier webhook
// delivery, Razorpay documents at-least-once retries) already marked
// this payment paid, this is a safe no-op: no second invoice number,
// no second subscription-period extension.
//
// req.rawBody is populated by the `verify` callback on the global
// express.json() middleware in app.js -- required because signature
// verification must run over the exact bytes Razorpay sent, not a
// re-serialized copy of the parsed body (see razorpayProvider.js).
// ==========================================

// Only these two events ever confirm a successful capture in this
// integration -- both carry payload.payment.entity with the same
// shape. payment.failed is deliberately NOT handled by writing to the
// database (see below): a failed attempt does not mean the ORDER is
// dead, and this codebase's status transitions have no path back out
// of 'failed' (see PaymentDetailsModal.jsx's TRANSITIONS map), so
// auto-marking a still-retryable order as 'failed' would incorrectly
// block a subsequent successful retry against the very same order.
const CAPTURE_EVENTS = new Set(["payment.captured", "order.paid"]);

const handleRazorpayWebhook = async (req, res) => {
    try {
        const provider = getProvider("razorpay");

        if (!provider.isWebhookConfigured()) {
            return res.status(503).json({ success: false, message: "Webhook is not configured." });
        }

        const signature = req.headers["x-razorpay-signature"];
        if (!signature || !req.rawBody) {
            return res.status(400).json({ success: false, message: "Missing signature or body." });
        }

        let validSignature;
        try {
            validSignature = provider.verifyWebhookSignature({ rawBody: req.rawBody, signature });
        } catch (verifyError) {
            console.error("[platform] webhook signature verification error:", verifyError.message);
            return res.status(503).json({ success: false, message: "Webhook is not configured." });
        }

        if (!validSignature) {
            console.warn("[platform] Razorpay webhook received with an invalid signature -- rejected.");
            return res.status(401).json({ success: false, message: "Invalid signature." });
        }

        // From here on the payload is trusted (signature-verified) --
        // but its CONTENTS are still just data, never bypassing the
        // same validation finalizePaymentSuccess/markPaymentPaid always
        // apply (guarded transition, unique provider_payment_id,
        // amount/order already fixed server-side at order-creation
        // time). Always acknowledge with 200 once the signature itself
        // is valid, per Razorpay's requirement that a webhook handler
        // ack quickly -- anything this handler can't/won't act on is
        // logged for visibility, never a 4xx/5xx that would trigger
        // Razorpay's retry storm for an event we've already understood.
        const event = req.body?.event;

        if (CAPTURE_EVENTS.has(event)) {
            const entity = req.body?.payload?.payment?.entity;
            const razorpayOrderId = entity?.order_id;
            const razorpayPaymentId = entity?.id;

            if (!razorpayOrderId || !razorpayPaymentId) {
                console.warn(`[platform] Webhook event "${event}" missing payment/order id -- ignored.`);
                return res.status(200).json({ success: true, message: "Event acknowledged (no payment/order id to process)." });
            }

            const payment = await paymentService.getPaymentByProviderOrderId(razorpayOrderId);
            if (!payment) {
                console.warn(`[platform] Webhook event "${event}" for unknown order ${razorpayOrderId} -- ignored.`);
                return res.status(200).json({ success: true, message: "Event acknowledged (no matching payment found)." });
            }

            if (payment.payment_status !== "pending" && payment.payment_status !== "paid") {
                // e.g. the Platform Owner already cancelled this payment --
                // a late webhook does not get to resurrect it automatically.
                console.warn(`[platform] Webhook event "${event}" for payment ${payment.id}, which is already ${payment.payment_status} -- ignored.`);
                return res.status(200).json({ success: true, message: "Event acknowledged (payment not in a processable state)." });
            }

            try {
                const result = await finalizePaymentSuccess(payment.id, razorpayPaymentId);
                console.log(`[platform] Webhook "${event}" confirmed payment ${payment.id} (subscriptionActivated=${result.subscriptionActivated}).`);
            } catch (finalizeError) {
                // A duplicate-provider-payment-id conflict here means this
                // exact Razorpay payment id is already attached to a
                // DIFFERENT internal row -- log for manual review, still
                // acknowledge so Razorpay doesn't retry forever.
                console.error(`[platform] Webhook "${event}" could not finalize payment ${payment.id}:`, finalizeError.message);
            }

            return res.status(200).json({ success: true, message: "Event processed." });
        }

        if (event === "payment.failed") {
            console.warn(`[platform] Webhook "payment.failed" received for order ${req.body?.payload?.payment?.entity?.order_id || "unknown"} -- logged only, payment left as-is for retry.`);
            return res.status(200).json({ success: true, message: "Event acknowledged (failed attempts do not change payment state)." });
        }

        console.log(`[platform] Webhook event "${event}" received -- not handled by this integration, acknowledged only.`);
        return res.status(200).json({ success: true, message: "Event acknowledged (not handled)." });

    } catch (error) {
        console.error("[platform] handleRazorpayWebhook failed:", error);
        return res.status(500).json({ success: false, message: "Webhook processing failed." });
    }
};

module.exports = {
    listPayments,
    getPaymentStats,
    getPaymentDetails,
    createPayment,
    updatePaymentStatus,
    handleRazorpayWebhook,
    createCheckoutPayment,
    createOrderForExistingPayment,
    verifyPayment,
};
