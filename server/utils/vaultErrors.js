// ZioVault errors. One consistent shape; the message never contains a secret, a key or anything the caller supplied.
// A resource the caller is not allowed to know about answers the SAME 404 as one that does not exist.

class VaultError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = "VaultError";
        this.status = status;
        this.code = code;
    }
}

const notFound = () => new VaultError(404, "NOT_FOUND", "Not found.");
const forbidden = (message = "You do not have the right to do that.") => new VaultError(403, "INSUFFICIENT_RIGHTS", message);
const invalid = (message = "Invalid request.", code = "INVALID_REQUEST") => new VaultError(400, code, message);
const conflict = (code, message) => new VaultError(409, code, message);

module.exports = { VaultError, notFound, forbidden, invalid, conflict };
