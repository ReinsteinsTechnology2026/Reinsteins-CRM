// Test stub for client/src/services/api.js: records requests and answers from a handler the test installs.
export const requests = [];
const api = {
  get: async (url) => {
    requests.push(url);
    return globalThis.__tenantFeaturesApi ? globalThis.__tenantFeaturesApi(url) : { data: {} };
  },
};
export default api;
