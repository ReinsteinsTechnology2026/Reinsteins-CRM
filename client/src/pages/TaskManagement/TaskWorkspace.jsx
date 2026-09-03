import { useEffect, useRef, useState } from "react";

import { useNavigate, useParams } from "react-router-dom";

import {
    FaArrowLeft,
    FaPaperclip,
    FaFileAlt,
    FaCheckCircle,
    FaUndo,
    FaPaperPlane,
    FaTrash,
    FaPen,
    FaExchangeAlt,
    FaTimes,
    FaUserPlus,
    FaPlay,
    FaStop,
    FaPlus,
} from "react-icons/fa";

import { toast } from "react-toastify";

import {
    getTaskById,
    updateTask,
    deleteTask,
    approveAndCloseTask,
    sendBackTask,
} from "../../services/taskManagementService";

import {
    getTaskActivity,
    postTaskActivity,
    editTaskActivity,
    deleteTaskActivity,
} from "../../services/taskActivityService";

import {
    getWorkItemLinks,
    deleteWorkItemLink,
} from "../../services/workItemLinkService";

import { getMyProjectPermissions } from "../../services/projectMemberService";

import { startWork } from "../../services/taskWorkService";

import MentionInput from "../../components/MentionInput";

import TagChips from "../../components/TagChips";

import EditTaskModal from "./EditTaskModal";

import TransferTaskModal from "./TransferTaskModal";

import AssignTaskModal from "./AssignTaskModal";

import WorkLogModal from "./WorkLogModal";

import AddRelationshipModal from "./AddRelationshipModal";

import {
    TASK_STATUS_LABELS,
    TASK_STATUS_CLASS,
    PRIORITY_CLASS,
    formatDate,
    formatDateTime,
} from "../../utils/workItemStatus";

import "../../styles/workItems.css";
import "./TaskWorkspace.css";

const FILE_BASE_URL = "http://localhost:5000";

// ==========================================
// FRONTEND-ONLY ATTACHMENT VALIDATION
// Mirrors server/middleware/taskUploadMiddleware.js's
// allow-list and 50MB limit for immediate UX
// feedback. The backend remains the source of
// truth and is not changed by this.
// ==========================================

const ALLOWED_ATTACHMENT_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
];

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

function formatFileSize(bytes) {

    if (bytes === undefined || bytes === null) return "";

    if (bytes < 1024) return `${bytes} B`;

    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

}

function getCurrentUser() {

    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }

}

// ==========================================
// ONE RELATIONSHIP GROUP (Blocks / Blocked By /
// Related) -- pure presentational, no hooks of its
// own, matching this file's existing convention of
// small module-scope helper functions.
// ==========================================

function RelationshipGroup({ label, items, canManage, onOpen, onRemove }) {

    return (

        <div className="task-relationship-group">

            <h3 className="task-relationship-group-title">{label}</h3>

            <div className="task-relationship-rows">

                {items.map((item) => (

                    <div key={item.linkId} className="task-relationship-row">

                        <button
                            type="button"
                            className="task-relationship-row-main"
                            onClick={() => onOpen(item.itemId)}
                        >

                            <span className="task-relationship-number">
                                T-{String(item.taskNumber || item.itemId).padStart(3, "0")}
                            </span>

                            <span className="task-relationship-title">{item.title}</span>

                            <span
                                className={
                                    TASK_STATUS_CLASS[item.status] ||
                                    "status-pill status-neutral"
                                }
                            >
                                {TASK_STATUS_LABELS[item.status] || item.status}
                            </span>

                        </button>

                        {canManage && (

                            <button
                                type="button"
                                className="task-relationship-remove"
                                onClick={() => onRemove(item.linkId)}
                                aria-label={`Remove relationship with Task #${item.taskNumber || item.itemId}`}
                            >
                                <FaTimes />
                            </button>

                        )}

                    </div>

                ))}

            </div>

        </div>

    );

}

function TaskWorkspace() {

    const { taskId } = useParams();

    const navigate = useNavigate();

    const currentUser = getCurrentUser();

    const [task, setTask] = useState(null);

    const [activity, setActivity] = useState([]);

    const [links, setLinks] = useState({ blocks: [], blockedBy: [], related: [] });

    const [linksLoading, setLinksLoading] = useState(true);

    const [showAddRelationship, setShowAddRelationship] = useState(false);

    // ==========================================
    // INLINE ACTIVITY EDIT STATE
    // Only one entry can be in edit mode at a time.
    // editingText/editingMentions mirror the same
    // { text, mentionedUserIds } shape MentionInput
    // already emits for the composer -- reused as-is.
    // ==========================================

    const [editingActivityId, setEditingActivityId] = useState(null);

    const [editingText, setEditingText] = useState("");

    const [savingEdit, setSavingEdit] = useState(false);

    const [loading, setLoading] = useState(true);

    const [accessDenied, setAccessDenied] = useState(false);

    const basePath = currentUser?.role === "admin" ? "/admin" : "/employee";

    // Project-linked task button visibility (TASK_EDIT/TASK_DELETE/
    // TASK_TRANSFER) — reuses the existing effective-permissions
    // endpoint the rest of the Project module already relies on
    // (getMyProjectPermissions -> GET /projects/:id/my-permissions,
    // itself gated by requireProjectMembership()). Non-project tasks
    // never trigger this fetch and keep the original role/assignee
    // based rules further below, completely unchanged.

    const [projectPermissions, setProjectPermissions] = useState(null);

    const [permissionsLoading, setPermissionsLoading] = useState(false);

    const [permissionsFailed, setPermissionsFailed] = useState(false);

    const [workflowLoading, setWorkflowLoading] = useState(false);

    const [showEditModal, setShowEditModal] = useState(false);

    const [showTransferModal, setShowTransferModal] = useState(false);

    const [showAssignModal, setShowAssignModal] = useState(false);

    const [showWorkLogModal, setShowWorkLogModal] = useState(false);

    const [deleting, setDeleting] = useState(false);

    // Composer

    const [composerType, setComposerType] = useState("comment");

    const [composerText, setComposerText] = useState("");

    const [composerMentions, setComposerMentions] = useState([]);

    const [composerProgress, setComposerProgress] = useState(0);

    // Each entry: { id, file, previewUrl }. previewUrl is an
    // object URL for images only, used for the pre-post
    // thumbnail preview, and revoked on removal/unmount.

    const [composerFiles, setComposerFiles] = useState([]);

    const composerFilesRef = useRef([]);

    const [dragActive, setDragActive] = useState(false);

    const [lightboxUrl, setLightboxUrl] = useState(null);

    const [posting, setPosting] = useState(false);

    useEffect(() => {

        composerFilesRef.current = composerFiles;

    }, [composerFiles]);

    // Revoke any staged preview URLs if the workspace unmounts
    // while attachments are still pending.

    useEffect(() => {

        return () => {

            composerFilesRef.current.forEach((item) => {
                if (item.previewUrl) {
                    URL.revokeObjectURL(item.previewUrl);
                }
            });

        };

    }, []);

    // Escape key closes the attachment lightbox.

    useEffect(() => {

        if (!lightboxUrl) return;

        function handleKeyDown(event) {
            if (event.key === "Escape") {
                setLightboxUrl(null);
            }
        }

        window.addEventListener("keydown", handleKeyDown);

        return () => window.removeEventListener("keydown", handleKeyDown);

    }, [lightboxUrl]);

    const loadTask = async () => {

        try {

            const response = await getTaskById(taskId);

            setTask(response.task);

            setComposerProgress(response.task.progress || 0);

        } catch (error) {

            console.error(error);

            const status = error.response?.status;

            if (status === 403 || status === 401 || status === 404) {
                setAccessDenied(true);
            } else {
                toast.error("Unable to load task");
            }

        }

    };

    const loadActivity = async () => {

        try {

            const response = await getTaskActivity(taskId);

            setActivity(response.activity || []);

        } catch (error) {

            console.error(error);

        }

    };

    const loadLinks = async () => {

        try {

            setLinksLoading(true);

            const response = await getWorkItemLinks("task", taskId);

            setLinks({
                blocks: response.blocks || [],
                blockedBy: response.blockedBy || [],
                related: response.related || [],
            });

        } catch (error) {

            console.error(error);

        } finally {

            setLinksLoading(false);

        }

    };

    const loadAll = async () => {

        setLoading(true);

        await Promise.all([loadTask(), loadActivity(), loadLinks()]);

        setLoading(false);

    };

    useEffect(() => {

        loadAll();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [taskId]);

    // Fetch effective project permissions only for a project-linked
    // task, only once task.project_id is known. Fails closed: any
    // rejection (including the 403 requireProjectMembership() returns
    // for a non-member) leaves projectPermissions null and
    // permissionsFailed true, which the gating booleans below treat
    // identically to "still loading" -- protected buttons stay hidden.

    useEffect(() => {

        if (!task?.project_id) {
            setProjectPermissions(null);
            setPermissionsLoading(false);
            setPermissionsFailed(false);
            return;
        }

        let cancelled = false;

        setPermissionsLoading(true);
        setPermissionsFailed(false);

        getMyProjectPermissions(task.project_id)
            .then((response) => {
                if (cancelled) return;
                setProjectPermissions(response.permissions || null);
            })
            .catch((error) => {
                console.error(error);
                if (cancelled) return;
                setProjectPermissions(null);
                setPermissionsFailed(true);
            })
            .finally(() => {
                if (!cancelled) setPermissionsLoading(false);
            });

        return () => {
            cancelled = true;
        };

    }, [task?.project_id]);

    // ==========================================
    // WORKFLOW ACTIONS
    // ==========================================

    const isAssignee = task && Number(task.assigned_to) === Number(currentUser?.id);

    const isAdmin = currentUser?.role === "admin";

    const isProjectTask = Boolean(task?.project_id);

    // True only once a successful permissions response has been
    // applied for the current project task -- false while loading,
    // on failure, and for the instant before the fetch effect above
    // has even started (initial state), which is exactly the "hide
    // until loaded" behavior required for project-linked tasks.

    const projectPermissionsReady =
        isProjectTask &&
        !permissionsLoading &&
        !permissionsFailed &&
        projectPermissions !== null;

    // Edit/Delete: for a project-linked task, driven entirely by the
    // backend's own TASK_EDIT/TASK_DELETE decision (via effective
    // permissions) -- role/admin status grants nothing here, matching
    // the backend's passesProjectPermission gate exactly. Non-project
    // tasks keep the original role-only rule, unchanged.

    const canEditTask = isProjectTask
        ? projectPermissionsReady && Boolean(projectPermissions.TASK_EDIT)
        : isAdmin;

    const canDeleteTask = isProjectTask
        ? projectPermissionsReady && Boolean(projectPermissions.TASK_DELETE)
        : isAdmin;

    // Transfer: for a project-linked task, driven by TASK_TRANSFER
    // instead of the assignee/admin/system_access rule below, which
    // remains exactly as-is for non-project tasks (mirrors
    // transferTask's own project_id branch in the backend).

    const canTransferTask = isProjectTask
        ? projectPermissionsReady && Boolean(projectPermissions.TASK_TRANSFER)
        : (
            isAssignee ||
            isAdmin ||
            ["super_admin", "admin"].includes(currentUser?.systemAccess)
        );

    // Assign/Reassign: a project-management action, deliberately
    // separate from Transfer above -- gated purely by TASK_ASSIGN, not
    // by being the current assignee. Only available for project-linked
    // tasks at all (matches the backend's own rejection of this action
    // for non-project tasks) -- non-project tasks never show this
    // button, preserving their existing Edit/Transfer-only behavior.

    const canAssignTask =
        isProjectTask &&
        projectPermissionsReady &&
        Boolean(projectPermissions.TASK_ASSIGN);

    // Submit for Review calls the generic updateTask endpoint, which
    // for a project-linked task requires TASK_EDIT on the backend
    // (see taskManagementController.updateTask) -- no separate
    // permission key is introduced here, this simply reuses TASK_EDIT.

    const canSubmitForReview = isProjectTask
        ? isAssignee && canEditTask
        : isAssignee;

    // Start/Stop Work: the assignee tracking their own time on their
    // own task. Gated purely by isAssignee (same shape as
    // canSubmitForReview's non-project branch) -- the backend's
    // passesProjectGate in taskWorkController.js is the real
    // authorization (ownership + TASK_CHANGE_STATUS for project
    // tasks); this only controls button visibility for the person the
    // control is actually for.

    const canTrackWork = isAssignee;

    // Approve & Close / Send Back: pure status transitions, reusing
    // TASK_CHANGE_STATUS (same key the Kanban/work-timer already use)
    // rather than a new permission key -- matches the backend's own
    // passesProjectPermission(task, "TASK_CHANGE_STATUS") gate in
    // approveTask/sendBackTask. Non-project tasks keep the original
    // role-only rule (isAdmin), completely unchanged.
    //
    // Review separation: !isAssignee mirrors the backend's own
    // isOwnTask exclusion in approveTask/sendBackTask -- the task's
    // own assignee never sees these buttons, matching the 403 they'd
    // get if they called the endpoint directly. UI-only convenience;
    // the backend check above is the real boundary.

    const canApproveTask = isProjectTask
        ? !isAssignee && projectPermissionsReady && Boolean(projectPermissions.TASK_CHANGE_STATUS)
        : isAdmin;

    const canSendBackTask = isProjectTask
        ? !isAssignee && projectPermissionsReady && Boolean(projectPermissions.TASK_CHANGE_STATUS)
        : isAdmin;

    // Relationships: a project-linked task only (legacy/non-project
    // tasks can never participate in a link -- see
    // workItemLinkService.createLink's NOT_PROJECT_LINKED check), and
    // driven purely by WORK_ITEM_LINK_MANAGE, not TASK_EDIT -- viewing
    // relationships only needs TASK_VIEW (enforced server-side by the
    // GET endpoint itself), which every visitor of this page already
    // has by definition.

    const canManageLinks =
        isProjectTask &&
        projectPermissionsReady &&
        Boolean(projectPermissions.WORK_ITEM_LINK_MANAGE);

    async function handleSubmitForReview() {

        try {

            setWorkflowLoading(true);

            await updateTask(task.id, {
                title: task.task_title,
                description: task.task_description,
                assigned_to: task.assigned_to,
                priority: task.priority,
                status: "pending_review",
                due_date: task.due_date,
                estimated_hours: task.estimated_hours,
                tags: task.tags,
            });

            toast.success("Task submitted for review");

            await loadTask();

        } catch (error) {

            console.error(error);

            toast.error("Unable to submit for review");

        } finally {

            setWorkflowLoading(false);

        }

    }

    async function handleApproveAndClose() {

        try {

            setWorkflowLoading(true);

            await approveAndCloseTask(task.id);

            toast.success("Task approved and closed");

            await loadTask();

        } catch (error) {

            console.error(error);

            toast.error("Unable to approve task");

        } finally {

            setWorkflowLoading(false);

        }

    }

    async function handleSendBack() {

        try {

            setWorkflowLoading(true);

            await sendBackTask(task.id);

            toast.success("Task sent back to employee");

            await loadTask();

        } catch (error) {

            console.error(error);

            toast.error("Unable to send back task");

        } finally {

            setWorkflowLoading(false);

        }

    }

    // ==========================================
    // START / STOP WORK
    // Stop Work never closes the task itself -- it
    // logs hours/progress and (at most) moves status
    // to a non-terminal value via WorkLogModal, which
    // no longer offers Completed/Closed. Reaching
    // "closed" still requires Submit for Review ->
    // Approve & Close, same as every other task.
    // ==========================================

    async function handleStartWork() {

        try {

            setWorkflowLoading(true);

            await startWork(task.id);

            toast.success("Work started");

            await loadTask();

        } catch (error) {

            console.error(error);

            toast.error("Unable to start work");

        } finally {

            setWorkflowLoading(false);

        }

    }

    async function handleRemoveLink(linkId) {

        const confirmed = window.confirm("Remove this relationship?");

        if (!confirmed) return;

        try {

            await deleteWorkItemLink(linkId);

            toast.success("Relationship removed");

            await Promise.all([loadLinks(), loadActivity()]);

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to remove relationship");

        }

    }

    async function handleDeleteTask() {

        const confirmed = window.confirm(
            `Delete Task #${task.task_number}? This cannot be undone.`
        );

        if (!confirmed) return;

        try {

            setDeleting(true);

            await deleteTask(task.id);

            toast.success("Task deleted successfully");

            navigate(-1);

        } catch (error) {

            console.error(error);

            toast.error("Unable to delete task");

            setDeleting(false);

        }

    }

    // ==========================================
    // COMPOSER — ATTACHMENT STATE
    // Shared by the Attach button, drag & drop,
    // and clipboard paste.
    // ==========================================

    function addFiles(incomingFiles) {

        const accepted = [];

        incomingFiles.forEach((file) => {

            if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
                toast.error(`${file.name}: unsupported file type`);
                return;
            }

            if (file.size > MAX_ATTACHMENT_SIZE) {
                toast.error(`${file.name}: exceeds the 50MB attachment limit`);
                return;
            }

            accepted.push(file);

        });

        if (accepted.length === 0) return;

        setComposerFiles((current) => [
            ...current,
            ...accepted.map((file) => ({
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                file,
                previewUrl: file.type.startsWith("image/")
                    ? URL.createObjectURL(file)
                    : null,
            })),
        ]);

    }

    function removeComposerFile(id) {

        setComposerFiles((current) => {

            const target = current.find((item) => item.id === id);

            if (target?.previewUrl) {
                URL.revokeObjectURL(target.previewUrl);
            }

            return current.filter((item) => item.id !== id);

        });

    }

    function clearComposerFiles() {

        composerFiles.forEach((item) => {
            if (item.previewUrl) {
                URL.revokeObjectURL(item.previewUrl);
            }
        });

        setComposerFiles([]);

    }

    function handleFileSelect(event) {

        addFiles(Array.from(event.target.files || []));

        // Allow selecting the exact same file again later.
        event.target.value = "";

    }

    function handleComposerPaste(event) {

        const items = event.clipboardData?.items;

        if (!items) return;

        const imageFiles = [];

        for (const item of items) {

            if (item.kind === "file" && item.type.startsWith("image/")) {

                const file = item.getAsFile();

                if (file) imageFiles.push(file);

            }

        }

        if (imageFiles.length > 0) {

            // Only intercept actual image data — normal text
            // paste into the textarea is left completely alone.

            event.preventDefault();

            addFiles(imageFiles);

        }

    }

    function handleComposerDragEnter(event) {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(true);
    }

    function handleComposerDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(true);
    }

    function handleComposerDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setDragActive(false);
    }

    function handleComposerDrop(event) {

        event.preventDefault();
        event.stopPropagation();

        setDragActive(false);

        const files = Array.from(event.dataTransfer?.files || []);

        if (files.length > 0) {
            addFiles(files);
        }

    }

    async function handlePostActivity(event) {

        event.preventDefault();

        if (!composerText.trim() && composerFiles.length === 0) {
            toast.error("Enter a comment or attach a file");
            return;
        }

        try {

            setPosting(true);

            await postTaskActivity(task.id, {
                activityType: composerType,
                body: composerText.trim(),
                progress: composerType === "work_update" ? composerProgress : undefined,
                mentionedUserIds: composerMentions,
                files: composerFiles.map((item) => item.file),
            });

            toast.success(
                composerType === "work_update"
                    ? "Work update posted"
                    : "Comment posted"
            );

            setComposerText("");
            setComposerMentions([]);
            clearComposerFiles();
            setComposerType("comment");

            await loadAll();

        } catch (error) {

            console.error(error);

            toast.error("Unable to post update");

        } finally {

            setPosting(false);

        }

    }

    async function handleDeleteActivity(activityId) {

        const confirmed = window.confirm("Delete this update?");

        if (!confirmed) return;

        try {

            await deleteTaskActivity(activityId);

            toast.success("Update deleted");

            await loadActivity();

        } catch (error) {

            console.error(error);

            toast.error("Unable to delete update");

        }

    }

    // ==========================================
    // INLINE ACTIVITY EDIT
    // Reuses editTaskActivity (already existed,
    // never wired up) and MentionInput (same
    // component the composer already uses) -- no
    // new endpoint, no new input component.
    // ==========================================

    function handleStartEdit(entry) {
        setEditingActivityId(entry.id);
        setEditingText(entry.body || "");
    }

    function handleCancelEdit() {
        setEditingActivityId(null);
        setEditingText("");
    }

    async function handleSaveEdit(activityId) {

        if (!editingText.trim()) {
            toast.error("Comment cannot be empty");
            return;
        }

        try {

            setSavingEdit(true);

            await editTaskActivity(activityId, editingText.trim());

            toast.success("Update edited");

            handleCancelEdit();

            await loadActivity();

        } catch (error) {

            console.error(error);

            toast.error(error.response?.data?.message || "Unable to edit update");

        } finally {

            setSavingEdit(false);

        }

    }

    if (loading) {
        return <div className="wi-loading">Loading task...</div>;
    }

    if (!task) {
        return (
            <div className="wi-empty-state">
                <h3>{accessDenied ? "You no longer have access to this task" : "Task not found"}</h3>
                <button
                    type="button"
                    className="wi-secondary-button"
                    onClick={() => navigate(`${basePath}/projects`)}
                >
                    <FaArrowLeft /> Back to Projects
                </button>
            </div>
        );
    }

    return (

        <div className="wi-page task-workspace">

            <div className="wi-breadcrumb">

                <button type="button" onClick={() => navigate(-1)}>
                    <FaArrowLeft /> Back
                </button>

                {task.project_name && (
                    <>
                        <span>/</span>
                        <span>{task.project_name}</span>
                    </>
                )}

                {task.user_story_title && (
                    <>
                        <span>/</span>
                        <span>{task.user_story_title}</span>
                    </>
                )}

                <span>/</span>
                <span className="current">Task #{task.task_number}</span>

            </div>

            {/* ==================================
                TASK HEADER
            ================================== */}

            <div className="wi-project-header">

                <div className="wi-project-header-top">

                    <div>
                        <span className="wi-code">
                            T-{String(task.task_number || task.id).padStart(3, "0")}
                        </span>
                        <h1>{task.task_title}</h1>
                    </div>

                    <div className="wi-project-header-actions">

                        <span
                            className={
                                TASK_STATUS_CLASS[task.status] ||
                                "status-pill status-neutral"
                            }
                        >
                            {TASK_STATUS_LABELS[task.status] || task.status}
                        </span>

                        {canEditTask && (

                            <button
                                type="button"
                                className="wi-secondary-button"
                                onClick={() => setShowEditModal(true)}
                            >
                                <FaPen /> Edit
                            </button>

                        )}

                        {canDeleteTask && (

                            <button
                                type="button"
                                className="wi-secondary-button task-workspace-delete-button"
                                disabled={deleting}
                                onClick={handleDeleteTask}
                            >
                                <FaTrash /> {deleting ? "Deleting..." : "Delete"}
                            </button>

                        )}

                        {canAssignTask && (

                            <button
                                type="button"
                                className="wi-secondary-button"
                                onClick={() => setShowAssignModal(true)}
                            >
                                <FaUserPlus /> {task.assigned_to ? "Reassign" : "Assign"}
                            </button>

                        )}

                        {canTransferTask && (

                            <button
                                type="button"
                                className="wi-secondary-button"
                                onClick={() => setShowTransferModal(true)}
                            >
                                <FaExchangeAlt /> Transfer
                            </button>

                        )}

                    </div>

                </div>

                <div className="wi-project-header-meta">

                    <div>
                        <label>Project</label>
                        <span>{task.project_name || "Unassigned (legacy task)"}</span>
                    </div>

                    <div>
                        <label>User Story</label>
                        <span>{task.user_story_title || "-"}</span>
                    </div>

                    <div>
                        <label>Assigned To</label>
                        <span>{task.assigned_to_name || "Unassigned"}</span>
                    </div>

                    <div>
                        <label>Assigned By</label>
                        <span>{task.assigned_by_name || "-"}</span>
                    </div>

                    <div>
                        <label>Priority</label>
                        <span
                            className={
                                PRIORITY_CLASS[task.priority] ||
                                "priority-pill priority-medium"
                            }
                        >
                            {task.priority}
                        </span>
                    </div>

                    <div>
                        <label>Due Date</label>
                        <span>{formatDate(task.due_date)}</span>
                    </div>

                    <div>
                        <label>Tags</label>
                        <TagChips tags={task.taskTags} emptyText="No tags" />
                    </div>

                </div>

                <div className="wi-project-progress-row">
                    <div className="wi-progress-track">
                        <div
                            className="wi-progress-fill"
                            style={{ width: `${task.progress || 0}%` }}
                        />
                    </div>
                    <span>{task.progress || 0}% Complete</span>
                </div>

                {/* ==================================
                    WORKFLOW ACTIONS
                ================================== */}

                <div className="task-workspace-actions">

                    {canTrackWork && !task.current_working && task.status !== "closed" && (

                        <button
                            type="button"
                            className="wi-secondary-button"
                            disabled={workflowLoading}
                            onClick={handleStartWork}
                        >
                            <FaPlay /> Start Work
                        </button>

                    )}

                    {canTrackWork && Boolean(task.current_working) && (

                        <button
                            type="button"
                            className="wi-secondary-button"
                            disabled={workflowLoading}
                            onClick={() => setShowWorkLogModal(true)}
                        >
                            <FaStop /> Stop Work
                        </button>

                    )}

                    {canSubmitForReview && task.status === "in_progress" && (

                        <button
                            type="button"
                            className="wi-primary-button"
                            disabled={workflowLoading}
                            onClick={handleSubmitForReview}
                        >
                            <FaPaperPlane /> Submit for Review
                        </button>

                    )}

                    {canApproveTask && task.status === "pending_review" && (

                        <button
                            type="button"
                            className="wi-primary-button"
                            disabled={workflowLoading}
                            onClick={handleApproveAndClose}
                        >
                            <FaCheckCircle /> Approve &amp; Close
                        </button>

                    )}

                    {canSendBackTask && task.status === "pending_review" && (

                        <button
                            type="button"
                            className="wi-secondary-button"
                            disabled={workflowLoading}
                            onClick={handleSendBack}
                        >
                            <FaUndo /> Send Back
                        </button>

                    )}

                </div>

            </div>

            {/* ==================================
                DESCRIPTION
            ================================== */}

            <div className="task-workspace-section">
                <h2>Description</h2>
                <p className="task-workspace-description">
                    {task.task_description || "No description provided."}
                </p>
            </div>

            {/* ==================================
                COMPOSER
            ================================== */}

            <div className="task-workspace-section task-composer-section">

                <h2>Post an Update</h2>

                <form
                    onSubmit={handlePostActivity}
                    onPaste={handleComposerPaste}
                    onDragEnter={handleComposerDragEnter}
                    onDragOver={handleComposerDragOver}
                    onDragLeave={handleComposerDragLeave}
                    onDrop={handleComposerDrop}
                    className={
                        dragActive
                            ? "task-composer task-composer-drag-active"
                            : "task-composer"
                    }
                >

                    {dragActive && (
                        <div className="task-composer-dropzone-overlay">
                            <FaPaperclip />
                            <span>Drop files to attach</span>
                        </div>
                    )}

                    <div className="task-composer-type-toggle">

                        <button
                            type="button"
                            className={composerType === "comment" ? "active" : ""}
                            onClick={() => setComposerType("comment")}
                        >
                            Comment
                        </button>

                        <button
                            type="button"
                            className={composerType === "work_update" ? "active" : ""}
                            onClick={() => setComposerType("work_update")}
                        >
                            Work Update
                        </button>

                    </div>

                    <MentionInput
                        value={composerText}
                        onChange={({ text, mentionedUserIds }) => {
                            setComposerText(text);
                            setComposerMentions(mentionedUserIds);
                        }}
                        placeholder={
                            composerType === "work_update"
                                ? "What did you work on? What's completed? Any blockers? Use @name to mention someone..."
                                : "Write a comment... Use @name to mention someone."
                        }
                        rows={4}
                    />

                    {composerType === "work_update" && (

                        <div className="task-composer-progress">

                            <label>Progress: {composerProgress}%</label>

                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={composerProgress}
                                onChange={(event) =>
                                    setComposerProgress(Number(event.target.value))
                                }
                            />

                        </div>

                    )}

                    {composerFiles.length > 0 && (

                        <div className="task-composer-attachment-preview">

                            {composerFiles.map((item) => (

                                <div key={item.id} className="task-composer-attachment-chip">

                                    {item.previewUrl ? (
                                        <img src={item.previewUrl} alt={item.file.name} />
                                    ) : (
                                        <div className="task-composer-attachment-icon">
                                            <FaFileAlt />
                                        </div>
                                    )}

                                    <div className="task-composer-attachment-info">
                                        <span className="task-composer-attachment-name">
                                            {item.file.name}
                                        </span>
                                        <span className="task-composer-attachment-size">
                                            {formatFileSize(item.file.size)}
                                        </span>
                                    </div>

                                    <button
                                        type="button"
                                        className="task-composer-attachment-remove"
                                        onClick={() => removeComposerFile(item.id)}
                                        aria-label={`Remove ${item.file.name}`}
                                    >
                                        <FaTimes />
                                    </button>

                                </div>

                            ))}

                        </div>

                    )}

                    <div className="task-composer-footer">

                        <label className="task-composer-attach-button">
                            <FaPaperclip />
                            Attach files
                            <input
                                type="file"
                                multiple
                                hidden
                                onChange={handleFileSelect}
                            />
                        </label>

                        <span className="task-composer-hint">
                            or drag &amp; drop files, or paste an image with Ctrl+V
                        </span>

                        <button
                            type="submit"
                            className="wi-primary-button"
                            disabled={posting}
                        >
                            {posting ? "Posting..." : "Post"}
                        </button>

                    </div>

                </form>

            </div>

            {/* ==================================
                RELATIONSHIPS
            ================================== */}

            <div className="task-workspace-section">

                <div className="task-relationships-heading-row">

                    <h2>Relationships</h2>

                    {canManageLinks && (

                        <button
                            type="button"
                            className="wi-secondary-button"
                            onClick={() => setShowAddRelationship(true)}
                        >
                            <FaPlus /> Add Relationship
                        </button>

                    )}

                </div>

                {linksLoading ? (

                    <p className="task-workspace-description">Loading relationships...</p>

                ) : (
                    links.blocks.length === 0 &&
                    links.blockedBy.length === 0 &&
                    links.related.length === 0
                ) ? (

                    <div className="wi-empty-state task-relationships-empty">
                        <p>No relationships yet.</p>
                    </div>

                ) : (

                    <div className="task-relationships-groups">

                        {links.blocks.length > 0 && (
                            <RelationshipGroup
                                label="Blocks"
                                items={links.blocks}
                                canManage={canManageLinks}
                                onOpen={(id) => navigate(`${basePath}/task-workspace/${id}`)}
                                onRemove={handleRemoveLink}
                            />
                        )}

                        {links.blockedBy.length > 0 && (
                            <RelationshipGroup
                                label="Blocked By"
                                items={links.blockedBy}
                                canManage={canManageLinks}
                                onOpen={(id) => navigate(`${basePath}/task-workspace/${id}`)}
                                onRemove={handleRemoveLink}
                            />
                        )}

                        {links.related.length > 0 && (
                            <RelationshipGroup
                                label="Related"
                                items={links.related}
                                canManage={canManageLinks}
                                onOpen={(id) => navigate(`${basePath}/task-workspace/${id}`)}
                                onRemove={handleRemoveLink}
                            />
                        )}

                    </div>

                )}

            </div>

            {/* ==================================
                ACTIVITY TIMELINE
            ================================== */}

            <div className="task-workspace-section">

                <h2 className="task-activity-heading">
                    Activity
                    {activity.length > 0 && (
                        <span className="task-activity-count">{activity.length}</span>
                    )}
                </h2>

                {activity.length === 0 ? (

                    <div className="wi-empty-state">
                        <p>No activity yet. Post the first work update or comment below.</p>
                    </div>

                ) : (

                    <div className="task-activity-timeline">

                        {activity.map((entry) => {

                            // System-generated audit entries (status changes,
                            // start/stop work, tag changes, transfer,
                            // reassignment, task creation, etc.) are
                            // permanent history and can never be deleted --
                            // the backend rejects this regardless, hiding
                            // the button here is purely a UI convenience.
                            const isImmutable =
                                entry.activity_type === "system" ||
                                entry.activity_type === "status_change";

                            const canDelete =
                                !isImmutable &&
                                (isAdmin ||
                                Number(entry.author_id) === Number(currentUser?.id));

                            // Edit is stricter than delete: author only, no
                            // admin override, and never for system/status_change
                            // entries (enforced authoritatively by the backend
                            // regardless of what this hides).
                            const canEdit =
                                !isImmutable &&
                                Number(entry.author_id) === Number(currentUser?.id);

                            const isEditingThis = editingActivityId === entry.id;

                            return (

                                <div key={entry.id} className="task-activity-entry">

                                    <div className="task-activity-avatar">
                                        {entry.author_name?.charAt(0).toUpperCase()}
                                    </div>

                                    <div className="task-activity-body">

                                        <div className="task-activity-top">

                                            <div>
                                                <strong>{entry.author_name}</strong>

                                                {entry.activity_type === "work_update" && (
                                                    <span className="task-activity-type-badge">
                                                        Work Update
                                                    </span>
                                                )}

                                                {entry.activity_type === "status_change" && (
                                                    <span className="task-activity-type-badge">
                                                        Status Change
                                                    </span>
                                                )}
                                            </div>

                                            <span className="task-activity-time">
                                                {formatDateTime(entry.created_at)}
                                                {Boolean(entry.is_edited) && " (edited)"}
                                            </span>

                                        </div>

                                        {isEditingThis ? (

                                            <div className="task-activity-edit-form">

                                                <MentionInput
                                                    value={editingText}
                                                    onChange={({ text }) => setEditingText(text)}
                                                    placeholder="Edit your update..."
                                                    rows={3}
                                                    disabled={savingEdit}
                                                />

                                                <div className="task-activity-edit-actions">

                                                    <button
                                                        type="button"
                                                        className="task-activity-edit-cancel"
                                                        onClick={handleCancelEdit}
                                                        disabled={savingEdit}
                                                    >
                                                        Cancel
                                                    </button>

                                                    <button
                                                        type="button"
                                                        className="task-activity-edit-save"
                                                        onClick={() => handleSaveEdit(entry.id)}
                                                        disabled={savingEdit}
                                                    >
                                                        {savingEdit ? "Saving..." : "Save"}
                                                    </button>

                                                </div>

                                            </div>

                                        ) : (

                                            entry.body && (
                                                <p className="task-activity-text">{entry.body}</p>
                                            )

                                        )}

                                        {entry.activity_type === "work_update" &&
                                            entry.progress_snapshot !== null && (
                                            <div className="task-activity-progress">
                                                Progress updated to <b>{entry.progress_snapshot}%</b>
                                            </div>
                                        )}

                                        {!isEditingThis && entry.mentions?.length > 0 && (
                                            <div className="task-activity-mentions">
                                                {entry.mentions.map((mention) => (
                                                    <span key={mention.mentioned_user_id}>
                                                        @{mention.mentioned_user_name}
                                                    </span>
                                                ))}
                                            </div>
                                        )}

                                        {entry.attachments?.length > 0 && (

                                            <div className="task-activity-attachments">

                                                {entry.attachments.map((file) => {

                                                    const isImage = file.file_type?.startsWith("image/");

                                                    const url = `${FILE_BASE_URL}${file.file_path}`;

                                                    return isImage ? (

                                                        <button
                                                            key={file.id}
                                                            type="button"
                                                            className="task-attachment-image"
                                                            onClick={() => setLightboxUrl(url)}
                                                        >
                                                            <img src={url} alt={file.original_name} />
                                                        </button>

                                                    ) : (

                                                        <a
                                                            key={file.id}
                                                            href={url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="task-attachment-file"
                                                        >
                                                            <FaFileAlt /> {file.original_name}
                                                        </a>

                                                    );

                                                })}

                                            </div>

                                        )}

                                        {!isEditingThis && (canEdit || canDelete) && (
                                            <div className="task-activity-actions">

                                                {canEdit && (
                                                    <button
                                                        type="button"
                                                        className="task-activity-edit"
                                                        onClick={() => handleStartEdit(entry)}
                                                    >
                                                        <FaPen /> Edit
                                                    </button>
                                                )}

                                                {canDelete && (
                                                    <button
                                                        type="button"
                                                        className="task-activity-delete"
                                                        onClick={() => handleDeleteActivity(entry.id)}
                                                    >
                                                        <FaTrash /> Delete
                                                    </button>
                                                )}

                                            </div>
                                        )}

                                    </div>

                                </div>

                            );

                        })}

                    </div>

                )}

            </div>

            {lightboxUrl && (

                <div
                    className="task-lightbox-overlay"
                    onClick={() => setLightboxUrl(null)}
                >

                    <button
                        type="button"
                        className="task-lightbox-close"
                        onClick={(event) => {
                            event.stopPropagation();
                            setLightboxUrl(null);
                        }}
                        aria-label="Close image preview"
                    >
                        <FaTimes />
                    </button>

                    <img
                        src={lightboxUrl}
                        alt="Attachment preview"
                        className="task-lightbox-image"
                        onClick={(event) => event.stopPropagation()}
                    />

                </div>

            )}

            {showEditModal && (

                <EditTaskModal
                    task={task}
                    onClose={() => setShowEditModal(false)}
                    onUpdated={async () => {
                        setShowEditModal(false);
                        await loadTask();
                    }}
                />

            )}

            {showTransferModal && (

                <TransferTaskModal
                    task={task}
                    onClose={() => setShowTransferModal(false)}
                    onTransferred={async () => {
                        setShowTransferModal(false);
                        await loadTask();
                    }}
                />

            )}

            {showAssignModal && (

                <AssignTaskModal
                    task={task}
                    onClose={() => setShowAssignModal(false)}
                    onAssigned={async () => {
                        setShowAssignModal(false);
                        await loadTask();
                    }}
                />

            )}

            {showWorkLogModal && (

                <WorkLogModal
                    task={task}
                    onClose={() => setShowWorkLogModal(false)}
                    onSaved={async () => {
                        setShowWorkLogModal(false);
                        await loadTask();
                    }}
                />

            )}

            {showAddRelationship && (

                <AddRelationshipModal
                    task={task}
                    onClose={() => setShowAddRelationship(false)}
                    onCreated={async () => {
                        setShowAddRelationship(false);
                        await loadLinks();
                        await loadActivity();
                    }}
                />

            )}

        </div>

    );

}

export default TaskWorkspace;
