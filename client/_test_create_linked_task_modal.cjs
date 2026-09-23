const fs = require("fs");
const path = require("path");

// ==========================================
// CreateLinkedTaskModal / ProjectWorkspace -- User Story selector
// regression self-test
//
// SCOPE / LIMITATION (read before trusting this file):
// This repo has no frontend test runner (client/package.json has only
// vite/oxlint -- no Jest/Vitest/React Testing Library, no jsdom). This
// script therefore does NOT mount the component or exercise real DOM
// interaction. It statically asserts on the exact source structure
// that caused this regression and that this fix depends on --
// specifically, the JSX gating condition around the User Story
// selector and the data-handling around it. It is a source-invariant
// check, not a behavioral/E2E test. It IS enough to catch the exact
// class of regression this bug was ("someone re-adds a
// userStories?.length > 0 gate and the selector silently disappears
// again"), which is what matters here.
//
// Root cause fixed: CreateLinkedTaskModal.jsx used to render the User
// Story <select> only when `mode === "project" && userStories?.length
// > 0`, so the selector vanished whenever a project had zero User
// Stories OR the getUserStories() call in ProjectWorkspace.jsx failed
// and was silently converted to []. Fixed by rendering the selector
// whenever `mode === "project"` (regardless of list length/failure),
// and by ProjectWorkspace.jsx distinguishing "empty" from "failed to
// load" via a dedicated storiesLoadFailed flag + a non-blocking toast/
// console.error, without fabricating story data.
// ==========================================

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

const linkedTaskModalPath = path.join(__dirname, "src/pages/Projects/CreateLinkedTaskModal.jsx");
const storyTaskModalPath = path.join(__dirname, "src/pages/Projects/CreateStoryTaskModal.jsx");
const projectWorkspacePath = path.join(__dirname, "src/pages/Employee/ProjectWorkspace.jsx");

const linkedTaskModalSrc = fs.readFileSync(linkedTaskModalPath, "utf8");
const storyTaskModalSrc = fs.readFileSync(storyTaskModalPath, "utf8");
const projectWorkspaceSrc = fs.readFileSync(projectWorkspacePath, "utf8");

// ==========================================
// 1. Direct Project -> Add Task always displays the User Story
// selector (mode === "project" is the ONLY gate -- no length check)
// ==========================================
console.log("\n1. SELECTOR ALWAYS RENDERS IN PROJECT MODE");

check(
    "The User Story block's condition is exactly `mode === \"project\"` (no userStories?.length gate)",
    /\{mode === "project" && \(\s*<div className="wi-form-group">\s*<label>User Story \(optional\)<\/label>/.test(linkedTaskModalSrc)
);

check(
    "The old regression condition (userStories?.length > 0 gating the whole block) is GONE",
    !/mode === "project" && userStories\?\.length > 0/.test(linkedTaskModalSrc)
);

// ==========================================
// 2. Selector remains optional; standalone task ("No User Story")
// remains supported; existing API payload semantics preserved
// ==========================================
console.log("\n2. OPTIONAL SELECTOR / STANDALONE TASK / PAYLOAD SEMANTICS");

check(
    "\"No User Story\" is always the first, unconditional option",
    /<option value="">No User Story<\/option>/.test(linkedTaskModalSrc)
);

check(
    "The user_story_id <select> has no `required` attribute (stays optional)",
    (() => {
        const selectBlockMatch = linkedTaskModalSrc.match(/<select\s+name="user_story_id"[\s\S]*?<\/select>/);
        return !!selectBlockMatch && !/\brequired\b/.test(selectBlockMatch[0]);
    })()
);

check(
    "name=\"user_story_id\" is unchanged (existing form-state wiring preserved)",
    /<select\s+name="user_story_id"/.test(linkedTaskModalSrc)
);

check(
    "Submit payload still converts an empty selection to null (existing API contract preserved: standalone task)",
    /user_story_id: formData\.user_story_id \|\| null/.test(linkedTaskModalSrc)
);

// ==========================================
// 3. Existing User Stories still appear when available
// ==========================================
console.log("\n3. EXISTING USER STORIES STILL RENDER WHEN PRESENT");

check(
    "userStories are still mapped into <option> elements inside the selector",
    /\(userStories \|\| \[\]\)\.map\(\(story\) => \(/.test(linkedTaskModalSrc) &&
    /<option key=\{story\.id\} value=\{story\.id\}>/.test(linkedTaskModalSrc)
);

// ==========================================
// 4. User Story API failure does not hide the selector, and does not
// fabricate data
// ==========================================
console.log("\n4. API FAILURE -- SELECTOR STAYS VISIBLE, NO FABRICATED DATA");

check(
    "userStories is defensively defaulted to [] when mapping (never assumes a populated array, never crashes on undefined)",
    /\(userStories \|\| \[\]\)\.map/.test(linkedTaskModalSrc)
);

check(
    "No fallback/dummy/mock User Story objects are hardcoded in the modal",
    !/(dummy|mock|placeholder)[A-Za-z]*\s*(Story|story)/i.test(linkedTaskModalSrc)
);

check(
    "ProjectWorkspace.loadAll() still only ever sets stories from the REAL API response on success, or [] on failure (never fabricates)",
    /setStories\(storiesRes\.status === "fulfilled" \? \(storiesRes\.value\.userStories \|\| \[\]\) : \[\]\)/.test(projectWorkspaceSrc)
);

// ==========================================
// 5. Distinguishing "no User Stories" from "failed to load" --
// non-blocking, no page-level error state, no fabricated data
// ==========================================
console.log("\n5. LOAD-FAILURE IS SURFACED, DISTINGUISHED, AND NON-BLOCKING");

check(
    "A dedicated storiesLoadFailed state exists (separate from the stories list itself)",
    /const \[storiesLoadFailed, setStoriesLoadFailed\] = useState\(false\)/.test(projectWorkspaceSrc)
);

check(
    "storiesLoadFailed is set from the User Stories request's OWN settled status, not from the other requests",
    /setStoriesLoadFailed\(storiesRes\.status === "rejected"\)/.test(projectWorkspaceSrc)
);

check(
    "A failure logs to console AND surfaces a non-blocking toast (existing react-toastify pattern), without throwing",
    /if \(storiesRes\.status === "rejected"\) \{\s*console\.error\("Failed to load User Stories:", storiesRes\.reason\);\s*toast\.error\(/.test(projectWorkspaceSrc)
);

check(
    "The User Stories failure branch does NOT set accessDenied or otherwise escalate to a page-level error state",
    (() => {
        const failureBlockMatch = projectWorkspaceSrc.match(/if \(storiesRes\.status === "rejected"\) \{[\s\S]*?\n {6}\}/);
        return !!failureBlockMatch && !/setAccessDenied/.test(failureBlockMatch[0]);
    })()
);

check(
    "The two REQUIRED calls (project/permissions) still throw-and-escalate exactly as before (page-level error handling untouched)",
    /if \(projectRes\.status === "rejected"\) \{\s*throw projectRes\.reason;\s*\}/.test(projectWorkspaceSrc) &&
    /if \(permissionsRes\.status === "rejected"\) \{\s*throw permissionsRes\.reason;\s*\}/.test(projectWorkspaceSrc)
);

check(
    "storiesLoadFailed is threaded into CreateLinkedTaskModal as a prop (surfaced at the point of use, not just logged)",
    /userStoriesLoadFailed=\{storiesLoadFailed\}/.test(projectWorkspaceSrc) &&
    /userStoriesLoadFailed,/.test(linkedTaskModalSrc)
);

check(
    "The modal shows a visible, non-blocking hint on failure, WITHOUT hiding or disabling the selector itself",
    (() => {
        const blockMatch = linkedTaskModalSrc.match(/\{mode === "project" && \([\s\S]*?\n {20}\)\}/);
        return !!blockMatch &&
            /userStoriesLoadFailed && \(/.test(blockMatch[0]) &&
            // the <select> itself must appear BEFORE the conditional hint,
            // i.e. unconditionally, not nested inside the failure check
            blockMatch[0].indexOf("<select") < blockMatch[0].indexOf("userStoriesLoadFailed &&");
    })()
);

// ==========================================
// 6. Contextual "User Story -> Add Task" remains completely unchanged
// ==========================================
console.log("\n6. CONTEXTUAL CREATION (User Story -> Add Task) UNCHANGED");

check(
    "CreateStoryTaskModal has NO user_story_id selector (story is fixed by context via the storyId prop, as before)",
    !/user_story_id/.test(storyTaskModalSrc) && /storyId/.test(storyTaskModalSrc)
);

check(
    "CreateStoryTaskModal still creates the task via createTaskInStory(storyId, ...) unchanged",
    /await createTaskInStory\(storyId, \{ \.\.\.formData, tagNames \}\)/.test(storyTaskModalSrc)
);

check(
    "ProjectWorkspace still renders CreateStoryTaskModal with storyId from createTaskForStory, unchanged",
    /<CreateStoryTaskModal[\s\S]*?storyId=\{createTaskForStory\}/.test(projectWorkspaceSrc)
);

// ==========================================
// 7. Out-of-scope guardrails -- this fix must not have touched Task
// permissions / TASK_ASSIGN / DB schema references in these files
// ==========================================
console.log("\n7. OUT-OF-SCOPE GUARDRAILS");

check(
    "CreateLinkedTaskModal does not reference TASK_ASSIGN (Task permission logic untouched)",
    !/TASK_ASSIGN/.test(linkedTaskModalSrc)
);

check(
    "CreateLinkedTaskModal's Assign To field / createProjectTask call are untouched by this fix",
    /await createProjectTask\(projectId, payload\)/.test(linkedTaskModalSrc)
);

// ==========================================
// SUMMARY
// ==========================================
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
