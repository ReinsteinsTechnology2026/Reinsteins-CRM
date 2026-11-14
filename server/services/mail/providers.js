const google = require("./googleProvider");
const microsoft = require("./microsoftProvider");

// The two mail providers behind one interface. Callers pick by an account's `provider` ("google" | "microsoft"); an unknown value
// is an error, never a silent default.
const PROVIDERS = { google, microsoft };

function getProvider(name) {
    const provider = PROVIDERS[name];
    if (!provider) throw new Error(`Unknown email provider "${name}"`);
    return provider;
}

module.exports = { getProvider, PROVIDERS };
