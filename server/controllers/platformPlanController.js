const subscriptionPlanService = require("../services/subscriptionPlanService");
const platformAuditService = require("../services/platformAuditService");

// ==========================================
// PLATFORM PLAN CONTROLLER (Phase 8)
//
// Every route using this controller is mounted behind platformProtect
// -- only an authenticated, active Platform Owner ever reaches these
// handlers. Pure CRUD-minus-delete against subscription_plans; never
// touches `companies`, `platform_users`, or any tenant database.
// ==========================================

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,59}$/;
const VALID_STATUS_ACTIONS = ["enable", "disable"];
const MAX_LIMIT_VALUE = 1000000;

const toSafePlan = (row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    employeeLimit: row.employee_limit,
    storageLimitMb: row.storage_limit_mb,
    monthlyPrice: row.monthly_price === null ? null : Number(row.monthly_price),
    yearlyPrice: row.yearly_price === null ? null : Number(row.yearly_price),
    trialDurationDays: row.trial_duration_days,
    features: (() => {
        if (row.features === null || row.features === undefined) return {};
        if (typeof row.features === "object") return row.features;
        try {
            return JSON.parse(row.features);
        } catch {
            return {};
        }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

// Shared validation for create/update -- only ever reads these six
// fields from the request body. Nothing else (id, slug on update,
// status) is ever accepted here.
const validatePlanFields = (body, { requireSlug }) => {

    const nameRaw = body?.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length < 2 || nameRaw.trim().length > 100) {
        return { error: "name is required (2-100 characters)." };
    }

    let slug;
    if (requireSlug) {
        const slugRaw = body?.slug;
        if (typeof slugRaw !== "string" || slugRaw.trim().length === 0) {
            return { error: "slug is required." };
        }
        slug = slugRaw.trim().toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            return {
                error:
                    "slug must be lowercase, start with a letter, contain only " +
                    "letters/digits/hyphens, and be 2-60 characters long.",
            };
        }
    }

    const descriptionRaw = body?.description;
    if (descriptionRaw !== undefined && descriptionRaw !== null && typeof descriptionRaw !== "string") {
        return { error: "description must be a string." };
    }
    if (typeof descriptionRaw === "string" && descriptionRaw.length > 2000) {
        return { error: "description must be 2000 characters or fewer." };
    }

    const parseLimit = (value, fieldName) => {
        if (value === undefined || value === null || value === "") return null;
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0 || num > MAX_LIMIT_VALUE) {
            throw new Error(`${fieldName} must be a non-negative whole number, or omitted for unlimited.`);
        }
        return num;
    };

    let employeeLimit;
    let storageLimitMb;
    let trialDurationDays;
    try {
        employeeLimit = parseLimit(body?.employeeLimit, "employeeLimit");
        storageLimitMb = parseLimit(body?.storageLimitMb, "storageLimitMb");
        trialDurationDays = parseLimit(body?.trialDurationDays, "trialDurationDays");
    } catch (limitError) {
        return { error: limitError.message };
    }

    // Prices are optional -- NULL means "not set yet", not $0. Stored
    // as a plain decimal; no currency/payment processing happens here
    // or anywhere else in this codebase (see platformPaymentController
    // -- there isn't one, deliberately).
    const parsePrice = (value, fieldName) => {
        if (value === undefined || value === null || value === "") return null;
        const num = Number(value);
        if (!Number.isFinite(num) || num < 0 || num > 10000000) {
            throw new Error(`${fieldName} must be a non-negative number, or omitted.`);
        }
        return Math.round(num * 100) / 100;
    };

    let monthlyPrice;
    let yearlyPrice;
    try {
        monthlyPrice = parsePrice(body?.monthlyPrice, "monthlyPrice");
        yearlyPrice = parsePrice(body?.yearlyPrice, "yearlyPrice");
    } catch (priceError) {
        return { error: priceError.message };
    }

    let features = {};
    if (body?.features !== undefined && body?.features !== null) {
        if (typeof body.features !== "object" || Array.isArray(body.features)) {
            return { error: "features must be a JSON object." };
        }
        features = body.features;
    }

    return {
        value: {
            name: nameRaw.trim(),
            slug,
            description: typeof descriptionRaw === "string" ? descriptionRaw.trim() : null,
            employeeLimit,
            storageLimitMb,
            monthlyPrice,
            yearlyPrice,
            trialDurationDays,
            features,
        },
    };

};

const listPlans = async (_req, res) => {
    try {
        const plans = await subscriptionPlanService.listPlans();
        return res.status(200).json({ success: true, plans: plans.map(toSafePlan) });
    } catch (error) {
        console.error("[platform] listPlans failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load plans." });
    }
};

const getPlanDetails = async (req, res) => {
    try {
        const planId = Number(req.params.id);
        if (!Number.isInteger(planId) || planId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid plan id." });
        }

        const plan = await subscriptionPlanService.getPlanById(planId);
        if (!plan) {
            return res.status(404).json({ success: false, message: "Plan not found." });
        }

        return res.status(200).json({ success: true, plan: toSafePlan(plan) });
    } catch (error) {
        console.error("[platform] getPlanDetails failed:", error);
        return res.status(500).json({ success: false, message: "Failed to load plan." });
    }
};

const createPlan = async (req, res) => {
    try {
        const { error, value } = validatePlanFields(req.body, { requireSlug: true });
        if (error) {
            return res.status(400).json({ success: false, message: error });
        }

        let plan;
        try {
            plan = await subscriptionPlanService.createPlan(value);
        } catch (createError) {
            if (createError.code === "PLAN_SLUG_TAKEN") {
                return res.status(409).json({ success: false, message: "A plan with this slug already exists." });
            }
            throw createError;
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "plan_created", targetType: "plan", targetId: plan.id,
            metadata: { name: plan.name, slug: plan.slug, monthlyPrice: value.monthlyPrice, yearlyPrice: value.yearlyPrice },
        }).catch((auditError) => console.error("[platform] audit log failed (plan_created):", auditError.message));

        return res.status(201).json({ success: true, plan: toSafePlan(plan) });
    } catch (error) {
        console.error("[platform] createPlan failed:", error);
        return res.status(500).json({ success: false, message: "Failed to create plan." });
    }
};

const updatePlan = async (req, res) => {
    try {
        const planId = Number(req.params.id);
        if (!Number.isInteger(planId) || planId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid plan id." });
        }

        const { error, value } = validatePlanFields(req.body, { requireSlug: false });
        if (error) {
            return res.status(400).json({ success: false, message: error });
        }

        const updated = await subscriptionPlanService.updatePlan(planId, value);
        if (!updated) {
            return res.status(404).json({ success: false, message: "Plan not found." });
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id, actionType: "plan_updated", targetType: "plan", targetId: updated.id,
            metadata: { name: updated.name, monthlyPrice: value.monthlyPrice, yearlyPrice: value.yearlyPrice },
        }).catch((auditError) => console.error("[platform] audit log failed (plan_updated):", auditError.message));

        return res.status(200).json({ success: true, plan: toSafePlan(updated) });
    } catch (error) {
        console.error("[platform] updatePlan failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update plan." });
    }
};

const updatePlanStatus = async (req, res) => {
    try {
        const planId = Number(req.params.id);
        if (!Number.isInteger(planId) || planId <= 0) {
            return res.status(400).json({ success: false, message: "Invalid plan id." });
        }

        // Only an explicit action verb is accepted -- never a raw
        // target status string -- mirroring the existing
        // companies/:id/status convention exactly.
        const action = req.body?.action;
        if (!VALID_STATUS_ACTIONS.includes(action)) {
            return res.status(400).json({
                success: false,
                message: `action must be one of: ${VALID_STATUS_ACTIONS.join(", ")}.`,
            });
        }

        const updated = await subscriptionPlanService.setPlanStatus(
            planId,
            action === "enable" ? "active" : "inactive"
        );

        if (!updated) {
            return res.status(404).json({ success: false, message: "Plan not found." });
        }

        await platformAuditService.logAction({
            platformUserId: req.platformUser.id,
            actionType: action === "disable" ? "plan_disabled" : "plan_enabled",
            targetType: "plan", targetId: updated.id, metadata: { name: updated.name },
        }).catch((auditError) => console.error("[platform] audit log failed (plan status):", auditError.message));

        return res.status(200).json({ success: true, plan: toSafePlan(updated) });
    } catch (error) {
        console.error("[platform] updatePlanStatus failed:", error);
        return res.status(500).json({ success: false, message: "Failed to update plan status." });
    }
};

module.exports = {
    listPlans,
    getPlanDetails,
    createPlan,
    updatePlan,
    updatePlanStatus,
};
