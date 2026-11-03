// ==========================================
// SMART SHEETS -- RATE / CONCURRENCY LIMITERS (in memory, single process)
//
// The CRM runs as ONE Node process, so in-memory counters are authoritative. If it is ever run as several
// processes these must move to a shared store (Redis or the database).
//
// Keys always include the database scope (see config/db.js roomScopeOf) AND the user id, because user ids
// restart at 1 in every database: a bare id would let one tenant's user 3 consume another tenant's budget.
// ==========================================

// Fixed-window counter. hit(key, weight) -> { allowed, retryAfterMs }. A refused hit consumes nothing.
function createWindowLimiter({ limit, windowMs, now = Date.now, maxKeys = 20000 }) {
    const entries = new Map(); // key -> { start, count }

    const prune = (current) => {
        for (const [key, entry] of entries) {
            if (current - entry.start >= windowMs) entries.delete(key);
        }
        // still too many live keys (a flood of distinct users): drop the oldest rather than grow without bound
        while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
    };

    return {
        hit(key, weight = 1) {
            const current = now();
            let entry = entries.get(key);
            if (!entry || current - entry.start >= windowMs) {
                entry = { start: current, count: 0 };
                entries.set(key, entry);
                if (entries.size > maxKeys) prune(current);
            }
            if (entry.count + weight > limit) {
                return { allowed: false, retryAfterMs: Math.max(1, entry.start + windowMs - current) };
            }
            entry.count += weight;
            return { allowed: true, retryAfterMs: 0 };
        },
        // test/diagnostics only
        get size() {
            return entries.size;
        },
        reset(key) {
            entries.delete(key);
        },
    };
}

// At most `max` holders at once. acquire() returns a release function, or null when full.
function createConcurrencyGate({ max }) {
    let active = 0;
    const perKey = new Map();
    return {
        acquire(key, perKeyMax = Infinity) {
            if (active >= max) return null;
            if ((perKey.get(key) || 0) >= perKeyMax) return null;
            active += 1;
            perKey.set(key, (perKey.get(key) || 0) + 1);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active -= 1;
                const left = (perKey.get(key) || 1) - 1;
                if (left <= 0) perKey.delete(key); else perKey.set(key, left);
            };
        },
        get active() {
            return active;
        },
    };
}

module.exports = { createWindowLimiter, createConcurrencyGate };
