// Two ZioVault requests are legitimately large, and carry only ciphertext and key envelopes:
//   * an attachment upload  (a file of up to 10 MiB, base64: about 14 MiB of text)
//   * re-keying a collection (every item of the collection, re-encrypted, in ONE request so it is all-or-nothing)
// Only those two routes, and only AFTER authentication and their rate limit (see routes/vaultRoutes.js), get a larger body limit; every
// other request keeps the app's small one. No dependencies: app.js and the router both read this.

const ATTACHMENT_JSON_LIMIT = "15mb";
const ROTATION_JSON_LIMIT = "16mb";
const UPLOAD_PATH = /^\/api\/ziovault\/items\/[^/]+\/attachments\/?$/;
const ROTATION_PATH = /^\/api\/ziovault\/collections\/[^/]+\/rotate\/?$/;

const pathOf = (req) => (req.originalUrl || req.url || "").split("?")[0];
const isAttachmentUpload = (req) => req.method === "POST" && UPLOAD_PATH.test(pathOf(req));
const isCollectionRotation = (req) => req.method === "POST" && ROTATION_PATH.test(pathOf(req));

// for the app-wide express.json(): leave these two routes to their own parsers
const appJsonType = (req) => !isAttachmentUpload(req) && !isCollectionRotation(req) && Boolean(req.is("application/json"));

module.exports = { ATTACHMENT_JSON_LIMIT, ROTATION_JSON_LIMIT, isAttachmentUpload, isCollectionRotation, appJsonType };
