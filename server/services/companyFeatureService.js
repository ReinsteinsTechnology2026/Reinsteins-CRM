const platformPool = require("../config/platformDb");
const { FEATURE_IDS } = require("../config/tenantFeatures");

// ==========================================
// COMPANY FEATURE SERVICE
//
// Reads and writes platform.company_features -- the Owner's decision about which CRM modules a company may use.
//
//   * A company with NO rows has never been configured: it gets every module (backward compatible).
//   * A company with rows is exactly what the rows say. A feature missing from a configured company (a module added to the
//     catalog later) is OFF until the Owner switches it on -- a new module never appears by itself.
//
// Reads are cached for a few seconds per company so the gate that runs on every API request and socket event costs one
// query per company per few seconds, not one per request. A change made through setCompanyFeatures() drops the cache entry
// at once, so on this single Node process it takes effect on the very next request.
// ==========================================

const CACHE_TTL_MS = 3000;

// `pool`: the platform database pool (tests pass a pool for a disposable database); `now`: the clock (tests move it).
function createCompanyFeatureService({ pool, now = () => Date.now() }) {
    const cache = new Map(); // companyId -> { at, states }

    function invalidate(companyId) {
        if (companyId === undefined) cache.clear();
        else cache.delete(Number(companyId));
    }

    // -> { configured, enabled: string[] }
    async function loadStates(companyId, queryable = pool) {
        const [rows] = await queryable.query(`SELECT feature_id, enabled FROM company_features WHERE company_id = ?`, [Number(companyId)]);
        if (rows.length === 0) return { configured: false, enabled: [...FEATURE_IDS] };
        const known = new Set(FEATURE_IDS);
        return { configured: true, enabled: rows.filter((row) => row.enabled === true && known.has(row.feature_id)).map((row) => row.feature_id) };
    }

    async function getFeatureStates(companyId) {
        const key = Number(companyId);
        if (!Number.isInteger(key) || key <= 0) return { configured: false, enabled: [] }; // an unresolvable company never gets features
        const hit = cache.get(key);
        if (hit && now() - hit.at < CACHE_TTL_MS) return hit.states;
        const states = await loadStates(key);
        cache.set(key, { at: now(), states });
        return states;
    }

    async function getEnabledFeatureIds(companyId) {
        return (await getFeatureStates(companyId)).enabled;
    }

    async function isFeatureEnabled(companyId, featureId) {
        return (await getEnabledFeatureIds(companyId)).includes(featureId);
    }

    // Writes the COMPLETE selection (every catalog feature gets an explicit row) in one transaction. The caller has already
    // validated `featureIds` (config/tenantFeatures.js validateSelection). Returns { before, after }.
    async function setCompanyFeatures(companyId, featureIds, platformUserId = null) {
        const key = Number(companyId);
        const wanted = new Set(featureIds);
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const before = await loadStates(key, connection);
            for (const featureId of FEATURE_IDS) {
                await connection.query(
                    `INSERT INTO company_features (company_id, feature_id, enabled, updated_by, updated_at)
                     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT (company_id, feature_id)
                     DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
                    [key, featureId, wanted.has(featureId), platformUserId]
                );
            }
            await connection.commit();
            invalidate(key);
            return { before: before.enabled, after: FEATURE_IDS.filter((id) => wanted.has(id)) };
        } catch (error) {
            try {
                await connection.rollback();
            } catch (_rollbackError) {
                // the original error is the one that matters
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    return { getFeatureStates, getEnabledFeatureIds, isFeatureEnabled, setCompanyFeatures, invalidate };
}

// The process-wide instance used by the application.
module.exports = { ...createCompanyFeatureService({ pool: platformPool }), createCompanyFeatureService, CACHE_TTL_MS };
