// Stand-in for client/src/services/api in the ZioVault UI test: forwards to whatever the test installed on globalThis.__zvHttp
// (which talks to the real Express router).
const call = (method, path, body) => globalThis.__zvHttp[method](path, body);
export default {
  get: (path) => call("get", path),
  post: (path, body) => call("post", path, body),
  patch: (path, body) => call("patch", path, body),
  put: (path, body) => call("put", path, body),
  delete: (path) => call("delete", path),
};
