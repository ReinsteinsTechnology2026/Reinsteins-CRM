// assigned_by records the authenticated user who last changed
// assigned_to. It only moves when the assignee actually changes, and
// it is never taken from client input.
function resolveAssignedBy({ assignedTo, currentAssignedTo, currentAssignedBy, actorId }) {
    if (assignedTo === null || assignedTo === undefined || assignedTo === "") {
        return null;
    }

    if (String(currentAssignedTo ?? "") === String(assignedTo)) {
        return currentAssignedBy ?? null;
    }

    return actorId;
}

// A field omitted from the request keeps its current value. An explicit
// null or empty value clears it. Used for owner_id and assigned_to.
function resolvePreservedId(requestedId, currentId) {
    if (requestedId === undefined) {
        return currentId ?? null;
    }

    return requestedId || null;
}

module.exports = {
    resolveAssignedBy,
    resolvePreservedId,
};
