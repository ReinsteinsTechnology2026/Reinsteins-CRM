import { employeesResponse } from "./backend.js";
export default { get: async (url) => { if (url === "/employees") return employeesResponse(); throw new Error("unexpected api.get " + url); } };
