// Rendered scenarios for the REAL AdminShiftManagement page (jsdom, MOCKED backend -- see stubs/backend.js).
// Bundled by the client's own Vite together with the project's real page, helpers and components; only the
// network modules (api, shiftScheduleService, socket, react-toastify) are replaced by the stubs.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AdminShiftManagement from "./pages/Admin/AdminShiftManagement.jsx";
import socket from "./services/socket.js";
import { makeBackend } from "./services/backend.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 40) => { await act(async () => { await sleep(ms); }); };
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);

async function click(el, ms) {
  if (!el) throw new Error("click: element not found");
  await act(async () => { el.click(); });
  await flush(ms);
}
async function setValue(el, value, ms) {
  if (!el) throw new Error("setValue: element not found");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
  await act(async () => {
    setter.call(el, value);
    // React listens to "input" for text/date inputs and to "change" for <select>
    el.dispatchEvent(new window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  await flush(ms);
}
const findButton = (label) => $$("button").find((b) => text(b) === label || b.getAttribute("aria-label") === label || (b.getAttribute("aria-label") || "").startsWith(label));
const button = (label) => {
  const found = findButton(label);
  if (!found) throw new Error("button not found: " + label + " | present: " + $$("button").map((b) => text(b) || b.getAttribute("aria-label")).join(" / "));
  return found;
};
const viewButton = (label) => $$(".shift-view-toggle-button").find((b) => text(b) === label);

async function openFinderAndSearch(query, wait = 60) {
  if (!$("#shift-finder")) await click(findButton("Find employee") || findButton("Change employee"));
  await setValue($("#shift-search-input"), query);
  await click($("#shift-finder button[type=submit]"), wait);
}

function snapshot() {
  const headerDates = $$(".shift-schedule-card thead th[data-date]").map((th) => th.getAttribute("data-date"));
  const rows = $$(".shift-schedule-card tbody tr").map((tr) => text(tr.querySelector("td:first-child")));
  return {
    range: text($(".shift-week-range")),
    activeView: text($(".shift-view-toggle-button.active")),
    headerDates,
    rows,
    chip: text($("[data-testid=shift-filter-summary]")),
    finderOpen: !!$("#shift-finder"),
    finderItems: $$(".shift-finder-item").map((b) => text(b.querySelector(".shift-finder-name"))),
    finderDayDetail: $$(".shift-finder-day").length,
    findButton: text($(".shift-find-button")),
    pickerValue: $(".shift-date-input") && $(".shift-date-input").value,
    pickerLabel: text($(".shift-date-field span")),
    error: text($("[role=alert]")),
    note: text($(".shift-empty-note")),
    emptyState: !!$(".shift-schedule-empty"),
    loading: !!$(".shift-schedule-loading"),
    searchEmpty: text($(".shift-search-empty")),
  };
}
const cellText = (name, date) => {
  const tr = $$(".shift-schedule-card tbody tr").find((r) => text(r.querySelector("td:first-child")).startsWith(name));
  return tr ? text(tr.querySelector(`td[data-date="${date}"]`)) : null;
};
const lastShiftCall = () => { const c = globalThis.__backend.calls.filter((x) => x.type === "getShifts"); return c[c.length - 1]; };
const shiftCalls = () => globalThis.__backend.calls.filter((x) => x.type === "getShifts").map((c) => `${c.startDate}..${c.endDate}${c.userId !== undefined ? ` uid=${c.userId}` : ""}`);

async function mount(setup) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__backend = makeBackend();
  globalThis.__toasts = [];
  if (setup) setup(globalThis.__backend);
  sessionStorage.setItem("user", JSON.stringify({ id: 1, role: "employee", systemAccess: "super_admin", designation: "Founder" }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" ").slice(0, 200));
  await act(async () => { root.render(<AdminShiftManagement />); });
  await flush(80);
  return {
    errors,
    async unmount() { console.error = original; await act(async () => root.unmount()); host.remove(); },
  };
}

const scenarios = {
  // a. overall Day / Week / Month schedules (everyone), incl. Previous/Next and the date picker
  async overall() {
    const page = await mount();
    const out = {};
    out.initial = { ...snapshot(), call: shiftCalls() };
    out.editableOwn = $$(".shift-cell-editable").length;
    await click(viewButton("Day")); out.day = { ...snapshot(), call: lastShiftCall() };
    await click(viewButton("Month")); out.month = { ...snapshot(), call: lastShiftCall(), asha21: cellText("Asha Rao", "2026-10-21"), bilal05: cellText("Bilal Khan", "2026-10-05") };
    await click(button("Next Month")); out.nextMonth = { ...snapshot(), call: lastShiftCall() };
    await click(button("Previous Month")); await click(button("Previous Month")); out.prevMonth2 = { ...snapshot(), call: lastShiftCall() };
    await setValue($(".shift-date-input"), "2028-02-10"); out.leap = { ...snapshot(), call: lastShiftCall() };
    await click(viewButton("Week")); await setValue($(".shift-date-input"), "2026-01-01"); out.yearBoundary = { ...snapshot(), call: lastShiftCall() };
    await setValue($(".shift-date-input"), ""); out.emptyPickerIgnored = snapshot().range;
    out.errors = page.errors; await page.unmount();
    return out;
  },

  // b + c + d + e. employee-specific schedules; search -> select -> collapse -> reopen -> clear
  async employee() {
    const page = await mount();
    const out = {};
    const beforeSearch = snapshot();
    await openFinderAndSearch("RS002");
    out.selected = { ...snapshot(), call: lastShiftCall(), calls: shiftCalls() };
    out.noSearchPanelLeft = !$("#shift-finder");
    out.editableWhenFiltered = $$(".shift-cell-editable").length;
    await click(viewButton("Day")); out.day = { ...snapshot(), call: lastShiftCall() };
    await click(viewButton("Month")); out.month = { ...snapshot(), call: lastShiftCall(), asha21: cellText("Asha Rao", "2026-10-21"), asha27: cellText("Asha Rao", "2026-10-27") };
    await click(button("Next Month")); out.nextMonth = { ...snapshot(), call: lastShiftCall() };
    await setValue($(".shift-date-input"), "2026-12-31"); out.picked = { ...snapshot(), call: lastShiftCall() };
    await click(viewButton("Week")); out.weekAfterPick = { ...snapshot(), call: lastShiftCall() };
    await click(button("Next Week")); out.weekNext = { ...snapshot(), call: lastShiftCall() };
    await click(button("Clear employee filter")); out.cleared = { ...snapshot(), call: lastShiftCall() };
    out.rangeKeptOnClear = out.weekNext.range === out.cleared.range;
    out.beforeSearch = beforeSearch;
    out.errors = page.errors; await page.unmount();
    return out;
  },

  async searchFlow() {
    const page = await mount();
    const out = {};
    await openFinderAndSearch("RS00");
    out.list = snapshot();
    await click($$(".shift-finder-item").find((b) => text(b).includes("Bilal")));
    out.afterPick = snapshot();
    await click(button("Change employee"));
    out.reopened = snapshot();
    await setValue($("#shift-search-input"), "RS004"); await click($("#shift-finder button[type=submit]"), 60);
    out.second = snapshot();
    await click(button("Clear employee filter"));
    out.cleared = snapshot();
    // day detail only in Day view
    await click(viewButton("Day")); await openFinderAndSearch("RS00"); out.dayResults = snapshot();
    await click(viewButton("Week")); out.weekResults = snapshot();
    await click(button("Close search")); out.closed = snapshot();
    out.errors = page.errors; await page.unmount();
    return out;
  },

  // selecting and clearing an employee must not reset the selected view/range
  async rangeKept() {
    const page = await mount();
    const out = {};
    await click(viewButton("Month")); await click(button("Next Month"));
    out.before = snapshot();
    await openFinderAndSearch("RS002");
    out.selected = { ...snapshot(), call: lastShiftCall() };
    await click(button("Clear employee filter"));
    out.cleared = { ...snapshot(), call: lastShiftCall() };
    out.errors = page.errors; await page.unmount();
    return out;
  },

  // an employee GET /employees does not return (admin-role account)
  async notListed() {
    const page = await mount();
    await openFinderAndSearch("RS005");
    const out = { selected: snapshot(), call: lastShiftCall() };
    await click(viewButton("Month")); out.month = snapshot();
    out.errors = page.errors; await page.unmount();
    return out;
  },

  // f. stale requests
  async stale() {
    const out = {};
    // 1. slow MONTH answer (marked LEAVE) must not overwrite the WEEK the user ended on
    let page = await mount((b) => { b.rules.push({ match: (c) => c.type === "getShifts" && c.startDate === "2026-10-01" && c.userId === undefined, delay: 500, status: "leave" }); });
    await click(viewButton("Month"), 10); await click(viewButton("Week"), 10);
    await flush(100); out.weekBefore = { range: snapshot().range, asha21: cellText("Asha Rao", "2026-10-21") };
    await flush(700); out.weekAfter = { range: snapshot().range, asha21: cellText("Asha Rao", "2026-10-21") };
    await page.unmount();
    // 2. slow FILTERED answer must not overwrite the cleared (everyone) view
    page = await mount((b) => { b.rules.push({ match: (c) => c.type === "getShifts" && c.userId === 2, delay: 500 }); });
    await openFinderAndSearch("RS002", 10);
    await click(button("Clear employee filter"), 10);
    await flush(100); const before = snapshot(); await flush(700); const after = snapshot();
    out.clear = { before: before.rows, after: after.rows, bilal21After: cellText("Bilal Khan", "2026-10-21"), chipAfter: after.chip };
    await page.unmount();
    // 3. slow earlier SEARCH must not replace the newer results (or reopen a dismissed list)
    page = await mount((b) => { b.rules.push({ match: (c) => c.type === "search" && c.q === "i", delay: 500 }); });
    await click(button("Find employee"));
    await setValue($("#shift-search-input"), "i"); await click($("#shift-finder button[type=submit]"), 10);
    await setValue($("#shift-search-input"), "sha"); await click($("#shift-finder button[type=submit]"), 10);
    await flush(100); out.searchBefore = snapshot().finderItems; await flush(700); out.searchAfter = snapshot().finderItems;
    await page.unmount();
    page = await mount((b) => { b.rules.push({ match: (c) => c.type === "search" && c.q === "i", delay: 400 }); });
    await click(button("Find employee"));
    await setValue($("#shift-search-input"), "i"); await click($("#shift-finder button[type=submit]"), 10);
    await click(button("Close search"), 10); await flush(600);
    out.dismissed = { finderOpen: snapshot().finderOpen, items: snapshot().finderItems };
    await page.unmount();
    return out;
  },

  // f. errors and empty results
  async errorsAndEmpty() {
    const out = {};
    let page = await mount((b) => { b.failNext = 1; });
    out.error = snapshot();
    await click(button("Retry"));
    out.retried = snapshot();
    await page.unmount();
    page = await mount();
    await openFinderAndSearch("zzz");
    out.noMatch = snapshot();
    await setValue($("#shift-search-input"), "RS004"); await click($("#shift-finder button[type=submit]"), 60);
    out.noShifts = snapshot();
    out.toasts = globalThis.__toasts;
    await page.unmount();
    return out;
  },

  // h. Administrative Override + duplicate-shift protection while another employee is filtered
  async override() {
    const out = {};
    const page = await mount();
    await openFinderAndSearch("RS002"); // filtered to Asha; only her shifts are loaded
    globalThis.__step = "open override 1";
    await click(button("Manage Employee Schedule"));
    const field = (name) => $(`.shift-override-modal [name=${name}]`);
    const saveButton = () => text($(".shift-override-modal .save-employee-button"));
    out.prefilled = { userId: field("userId").value, date: field("shiftDate").value, save: saveButton() };
    // Asha's own date has no entry on the 19th: switch to Bilal (not loaded) -> create; then to the 21st where Bilal HAS an entry
    await setValue(field("userId"), "3", 80);
    out.bilal19 = saveButton();
    out.debugCalls = globalThis.__backend.calls.map((c) => c.type + ":" + (c.startDate || c.q || "") + ".." + (c.endDate || "") + (c.userId !== undefined ? " u=" + c.userId : ""));
    await setValue(field("shiftDate"), "2026-10-21", 120);
    out.bilal21 = { save: saveButton(), locked: field("userId").disabled, lookups: globalThis.__backend.calls.filter((c) => c.type === "getShifts" && Number(c.userId) === 3 && c.startDate === c.endDate).map((c) => c.startDate) };
    globalThis.__step = "cancel after bilal21";
    await click(button("Cancel"));
    // immediate submit race: choose employee 3 + date 2026-10-05 with a SLOW lookup and submit before it returns
    globalThis.__backend.rules.push({ match: (c) => c.type === "getShifts" && Number(c.userId) === 3 && c.startDate === c.endDate, delay: 300 });
    await click(button("Manage Employee Schedule"));
    await setValue(field("userId"), "3", 5);
    await setValue(field("shiftDate"), "2026-10-05", 5);
    await act(async () => { $(".shift-override-modal form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    await flush(500);
    out.race = { creates: globalThis.__backend.calls.filter((c) => c.type === "create").length, save: saveButton(), toasts: globalThis.__toasts.map((t) => `${t.type}:${t.message}`) };
    globalThis.__step = "cancel after race";
    out.raceModalOpen = !!$(".shift-override-modal");
    if ($(".shift-override-modal")) await click(button("Cancel"));
    // a genuine create for an employee with no entry works (no 409)
    globalThis.__backend.rules.length = 0;
    await click(button("Manage Employee Schedule"));
    await setValue(field("userId"), "4", 80);
    await setValue(field("shiftDate"), "2026-10-22", 120);
    out.chitra = saveButton();
    await click($(".shift-override-modal .save-employee-button"), 700);
    out.created = { creates: globalThis.__backend.calls.filter((c) => c.type === "create").map((c) => `${c.userId}@${c.shiftDate}`), chip: snapshot().chip, toasts: globalThis.__toasts.map((t) => `${t.type}:${t.message}`) };
    // the server's duplicate protection still answers 409 for a blind duplicate create
    let status = null;
    try { await (await import("./services/shiftScheduleService.js")).createShift({ userId: 3, shiftDate: "2026-10-21", status: "working", startTime: "09:00", endTime: "18:00" }); } catch (e) { status = e.response.status; }
    out.duplicateStatus = status;
    out.overridePanel = !!$(".shift-override-panel, .shift-override-panel-compact");
    out.errors = page.errors; await page.unmount();
    return out;
  },

  // live updates merged only inside the range and, when filtered, only for that employee
  // i. Reports panel: replaces the Administrative Override box; Day/Week/Month, All/Particular employee, Download Excel
  async reports() {
    const out = {};
    const page = await mount();
    const downloads = [];
    const onClick = (e) => { const a = e.target.closest && e.target.closest("a[download]"); if (a) { downloads.push(a.getAttribute("download")); e.preventDefault(); } };
    document.addEventListener("click", onClick, true);
    window.URL.createObjectURL = () => "blob:report";
    window.URL.revokeObjectURL = () => {};
    const panel = () => $(".shift-reports-panel");
    const group = (label) => $$(`.shift-reports-panel [role=group][aria-label="${label}"] button`);
    const exportCalls = () => globalThis.__backend.calls.filter((c) => c.type === "export").map((c) => `${c.period}:${c.employee}`);
    const download = () => $(".shift-reports-download");

    out.boxGone = !$(".shift-override-panel, .shift-override-panel-compact") && !text($("header.shift-page-header")).includes("Administrative Override");
    out.heading = text(panel().querySelector("strong"));
    out.inHeader = !!$("header.shift-page-header .shift-reports-panel");
    out.periodOptions = group("Report period").map(text);
    out.scopeOptions = group("Report employees").map(text);
    out.noDatePicker = $$(".shift-reports-panel input").length === 0;
    out.defaults = { period: text(group("Report period").find((b) => b.getAttribute("aria-pressed") === "true")), scope: text(group("Report employees").find((b) => b.getAttribute("aria-pressed") === "true")), dropdown: !!$(".shift-reports-employee") };
    out.hintWeek = text(panel().querySelector("p"));

    // All employees, Month
    await click(group("Report period").find((b) => text(b) === "Month"));
    out.hintMonth = text(panel().querySelector("p"));
    await click(download(), 60);
    out.afterAll = { calls: exportCalls(), files: [...downloads], label: text(download()) };

    // Particular employee: dropdown from the CRM employee list, Download disabled until one is chosen
    await click(group("Report employees").find((b) => text(b) === "Particular Employee"));
    const select = $(".shift-reports-employee select");
    out.options = [...select.options].map((o) => o.textContent);
    out.disabledWithoutEmployee = download().disabled;
    await click(download(), 30);
    out.callsWhileDisabled = exportCalls().length;
    await setValue(select, "3");
    out.enabledWithEmployee = !download().disabled;
    await click(group("Report period").find((b) => text(b) === "Day"));
    await click(download(), 60);
    out.afterOne = { calls: exportCalls(), files: [...downloads] };

    // the timetable and its other controls are unaffected by using the Reports panel
    out.scheduleStill = { range: text($(".shift-week-range")), rows: $$(".shift-schedule-card tbody tr").length };

    // Admin-only error from the server is shown, not swallowed
    globalThis.__backend.exportFails = true;
    await click(download(), 60);
    out.errorToast = globalThis.__toasts.filter((t) => t.type === "error").map((t) => t.message);
    out.stillEnabledAfterError = !download().disabled;

    // the two override actions survive, outside the Reports panel
    out.adminActions = [...$$(".shift-toolbar-admin-actions button").map(text)];
    out.actionsOutsidePanel = !panel().contains($(".shift-toolbar-admin-actions"));

    document.removeEventListener("click", onClick, true);
    out.errors = page.errors; await page.unmount();
    return out;
  },

  async live() {
    const page = await mount();
    const out = {};
    await openFinderAndSearch("RS002");
    const emit = async (p) => { await act(async () => { socket.emit("shift:updated", p); }); await flush(); };
    await emit({ id: 501, userId: 3, shiftDate: "2026-10-22", status: "working", startTime: "07:00", endTime: "15:00", action: "created" });
    out.otherEmployeeIgnored = snapshot().rows;
    await emit({ id: 502, userId: 2, shiftDate: "2026-10-22", status: "working", startTime: "11:00", endTime: "20:00", action: "created" });
    out.selectedMerged = cellText("Asha Rao", "2026-10-22");
    await emit({ id: 503, userId: 2, shiftDate: "2026-11-20", status: "working", startTime: "11:00", endTime: "20:00", action: "created" });
    out.outsideRangeIgnored = snapshot().rows.length;
    await click(button("Clear employee filter"));
    await emit({ id: 504, userId: 3, shiftDate: "2026-10-22", status: "working", startTime: "07:00", endTime: "15:00", action: "created" });
    out.everyoneAfterClear = cellText("Bilal Khan", "2026-10-22");
    out.errors = page.errors; await page.unmount();
    return out;
  },
};

export async function runAll() {
  const results = {};
  for (const [name, fn] of Object.entries(scenarios)) results[name] = await fn();
  return results;
}
