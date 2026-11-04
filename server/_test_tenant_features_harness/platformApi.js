// Test stub for client/src/services/platformApi.js (the Owner Portal's HTTP client): records every call in
// globalThis.__platformCalls and answers from a handler the test installs: globalThis.__platformApi(method, url, body) -> { data }.
const run = async (method, url, body) => {
  (globalThis.__platformCalls = globalThis.__platformCalls || []).push({ method, url, body });
  return globalThis.__platformApi ? globalThis.__platformApi(method, url, body) : { data: {} };
};
const platformApi = {
  get: (url) => run("GET", url),
  post: (url, body) => run("POST", url, body),
  put: (url, body) => run("PUT", url, body),
  patch: (url, body) => run("PATCH", url, body),
  delete: (url) => run("DELETE", url),
};
export default platformApi;
