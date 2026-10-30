// ==========================================
// SMART SHEETS -- ERRORS
//
// One error type for every expected failure (bad input, no access, not found, ...), so the REST
// controller and the socket handlers translate them identically: `status` is the HTTP status,
// `code` a stable machine-readable string the client switches on, `message` is safe to show.
// Anything that is NOT a SmartSheetError is an unexpected bug and is reported as a generic 500.
//
// An unassigned employee and a missing sheet deliberately produce the SAME error (NOT_FOUND):
// the response must not reveal whether a guessed sheet id exists.
// ==========================================

class SmartSheetError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "SmartSheetError";
        this.status = status;
        this.code = code;
    }
}

const notFound = () => new SmartSheetError(404, "NOT_FOUND", "Spreadsheet not found.");
const forbidden = (message = "You do not have permission to do that.") => new SmartSheetError(403, "FORBIDDEN", message);
const invalid = (code, message) => new SmartSheetError(400, code, message);

module.exports = { SmartSheetError, notFound, forbidden, invalid };
