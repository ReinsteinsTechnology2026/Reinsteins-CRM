import {
  useEffect,
  useState,
} from "react";

import {
  FaPlus,
  FaTimes,
  FaUsers,
  FaEdit,
  FaUserCheck,
  FaUserSlash,
  FaEye,
  FaEnvelope,
  FaPhone,
  FaMapMarkerAlt,
  FaBriefcase,
  FaBirthdayCake,
  FaIdBadge,
  FaPhoneAlt,
  FaSignOutAlt,
  FaBan,
  FaUserPlus,
  FaHistory,
  FaCalendarAlt,
  FaGraduationCap,
  FaCheckCircle,
  FaLevelUpAlt,
  FaMoneyBillWave,
  FaUserTie,
  FaSitemap,
  FaBuilding,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";


import api from "../../services/api";
import { API_ORIGIN } from "../../config";

import "./Employees.css";

// ==========================================
// BACKEND URL
// ==========================================

const BACKEND_URL = API_ORIGIN;

function Employees() {

  // ========================================
  // STATE
  // ========================================

  const [
    employees,
    setEmployees,
  ] = useState([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    showForm,
    setShowForm,
  ] = useState(false);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    selectedEmployee,
    setSelectedEmployee,
  ] = useState(null);

  const [
    formData,
    setFormData,
  ] = useState({
    employeeId: "",
    fullName: "",
    email: "",
    designation: "",
    password: "",
    departmentId: "",
    reportingManagerId: "",
    systemAccess: "employee",
  });

  const [
    generatingId,
    setGeneratingId,
  ] = useState(false);

  const [
    departments,
    setDepartments,
  ] = useState([]);

  const [
    designationsCatalog,
    setDesignationsCatalog,
  ] = useState([]);

  const [
    orgTarget,
    setOrgTarget,
  ] = useState(null);

  const [
    orgForm,
    setOrgForm,
  ] = useState({
    designation: "",
    departmentId: "",
    reportingManagerId: "",
    systemAccess: "employee",
  });

  const [
    orgSaving,
    setOrgSaving,
  ] = useState(false);

  // ========================================
  // EMPLOYEE LIFECYCLE STATE
  // (resign / terminate / rehire / history)
  // ========================================

  const [
    activeTab,
    setActiveTab,
  ] = useState("activeEmployees");

  const [
    resignTarget,
    setResignTarget,
  ] = useState(null);

  const [
    terminateTarget,
    setTerminateTarget,
  ] = useState(null);

  const [
    rehireTarget,
    setRehireTarget,
  ] = useState(null);

  const [
    lifecycleForm,
    setLifecycleForm,
  ] = useState({
    lastWorkingDate: "",
    reason: "",
    exitNotes: "",
  });

  const [
    rehireForm,
    setRehireForm,
  ] = useState({
    designation: "",
    joiningDate: "",
    notes: "",
  });

  const [
    lifecycleSaving,
    setLifecycleSaving,
  ] = useState(false);

  const [
    employmentHistory,
    setEmploymentHistory,
  ] = useState([]);

  const [
    historyLoading,
    setHistoryLoading,
  ] = useState(false);

  // ========================================
  // INTERN STATE
  // ========================================

  const [
    showInternForm,
    setShowInternForm,
  ] = useState(false);

  const [
    internFormData,
    setInternFormData,
  ] = useState({
    internId: "",
    fullName: "",
    email: "",
    designation: "",
    mentorId: "",
    password: "",
    departmentId: "",
    reportingManagerId: "",
  });

  const [
    generatingInternId,
    setGeneratingInternId,
  ] = useState(false);

  const [
    completeTarget,
    setCompleteTarget,
  ] = useState(null);

  const [
    discontinueTarget,
    setDiscontinueTarget,
  ] = useState(null);

  const [
    convertTarget,
    setConvertTarget,
  ] = useState(null);

  const [
    rehireInternTarget,
    setRehireInternTarget,
  ] = useState(null);

  // ========================================
  // LOAD EMPLOYEES
  // ========================================

  const loadEmployees =
    async () => {
      try {
        setLoading(true);

        const response =
          await api.get(
            "/employees"
          );

        setEmployees(
          response.data
            .employees || []
        );

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to load employees"
        );

      } finally {

        setLoading(false);

      }
    };

  useEffect(() => {
    loadEmployees();
    loadDepartments();
    loadDesignationsCatalog();
  }, []);

  // ========================================
  // DEPARTMENTS + DESIGNATIONS CATALOG
  // (for the Add Employee/Intern and Organization
  // modal dropdowns — managed on the Organization
  // admin page, read-only here)
  // ========================================

  const loadDepartments = async () => {
    try {
      const response = await api.get("/departments");
      setDepartments((response.data.departments || []).filter((d) => d.status === "active"));
    } catch (error) {
      console.error("Load departments error:", error);
    }
  };

  const loadDesignationsCatalog = async () => {
    try {
      const response = await api.get("/designations");
      setDesignationsCatalog((response.data.designations || []).filter((d) => d.status === "active"));
    } catch (error) {
      console.error("Load designations catalog error:", error);
    }
  };

  // ========================================
  // CURRENT USER'S SYSTEM ACCESS
  // Only used to decide whether the System
  // Access field/action is shown — the backend
  // independently enforces this regardless.
  // ========================================

  const currentUser = (() => {
    try {
      return JSON.parse(sessionStorage.getItem("user"));
    } catch {
      return null;
    }
  })();

  const canManageSystemAccess = ["super_admin", "admin"].includes(currentUser?.systemAccess) || currentUser?.role === "admin";

  // ========================================
  // FETCH NEXT EMPLOYEE ID (PREVIEW ONLY)
  //
  // Display-only, so the Admin sees the next
  // Employee ID immediately when the modal
  // opens without typing it. This is NOT what
  // actually gets saved — the backend
  // independently (re)generates and safely
  // retries the real ID at creation time, so a
  // stale preview here (e.g. two admins opening
  // the modal at once) can never cause a
  // duplicate.
  // ========================================

  const fetchNextEmployeeId =
    async () => {
      try {

        setGeneratingId(true);

        const response =
          await api.get(
            "/employees/next-employee-id"
          );

        setFormData(
          (previous) => ({
            ...previous,
            employeeId:
              response.data
                .nextEmployeeId ||
              "",
          })
        );

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to generate the next employee ID"
        );

      } finally {

        setGeneratingId(false);

      }
    };

  // ========================================
  // OPEN ADD EMPLOYEE MODAL
  // ========================================

  const handleOpenAddEmployee =
    () => {

      setFormData({
        employeeId: "",
        fullName: "",
        email: "",
        designation: "",
        password: "",
        departmentId: "",
        reportingManagerId: "",
        systemAccess: "employee",
      });

      setShowForm(true);

      fetchNextEmployeeId();

    };

  // ========================================
  // FETCH NEXT INTERN ID (PREVIEW ONLY)
  // Same display-only/non-authoritative pattern
  // as fetchNextEmployeeId above, just against
  // the independent "INT" sequence.
  // ========================================

  const fetchNextInternId =
    async () => {
      try {

        setGeneratingInternId(
          true
        );

        const response =
          await api.get(
            "/employees/next-intern-id"
          );

        setInternFormData(
          (previous) => ({
            ...previous,
            internId:
              response.data
                .nextInternId ||
              "",
          })
        );

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to generate the next intern ID"
        );

      } finally {

        setGeneratingInternId(
          false
        );

      }
    };

  // ========================================
  // OPEN ADD INTERN MODAL
  // ========================================

  const handleOpenAddIntern =
    () => {

      setInternFormData({
        internId: "",
        fullName: "",
        email: "",
        designation: "",
        mentorId: "",
        password: "",
        departmentId: "",
        reportingManagerId: "",
      });

      setShowInternForm(
        true
      );

      fetchNextInternId();

    };

  const handleInternFormChange =
    (event) => {

      const {
        name,
        value,
      } = event.target;

      setInternFormData(
        (previous) => ({
          ...previous,
          [name]: value,
        })
      );

    };

  // ========================================
  // CREATE INTERN
  // Posts to the SAME /employees endpoint as
  // Add Employee, with employmentType:'intern'
  // — the backend branches on that field rather
  // than duplicating the whole creation flow.
  // ========================================

  const handleSubmitIntern =
    async (event) => {

      event.preventDefault();

      if (
        !internFormData.internId ||
        generatingInternId
      ) {
        toast.error(
          "Intern ID is still being generated, please wait a moment"
        );

        return;
      }

      try {

        setSaving(true);

        await api.post(
          "/employees",
          {
            ...internFormData,
            employmentType:
              "intern",
          }
        );

        toast.success(
          "Intern created successfully"
        );

        setShowInternForm(
          false
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to create intern"
        );

      } finally {

        setSaving(false);

      }

    };

  // ========================================
  // ORGANIZATION MODAL
  // Department + Reporting Manager (one
  // controlled transfer operation) and, where
  // authorized, System Access — all validated
  // and history-recorded server-side.
  // ========================================

  const openOrgModal = (employee) => {

    setOrgForm({
      designation: employee.designation || "",
      departmentId: employee.department_id || "",
      reportingManagerId: employee.reporting_manager_id || "",
      systemAccess: employee.system_access || "employee",
      projectAccess: employee.project_access_override || "default",
      projectAccessLevel: employee.project_access_level || "basic",
    });

    setOrgTarget(employee);

  };

  const handleOrgFieldChange = (event) => {

    const { name, value } = event.target;

    setOrgForm((previous) => ({ ...previous, [name]: value }));

  };

  const handleOrgSubmit = async (event) => {

    event.preventDefault();

    try {

      setOrgSaving(true);

      // Designation is not part of the organization-transfer endpoint —
      // it's saved through the existing employee update endpoint, which
      // already supports changing (or clearing) it. Only called when it
      // actually changed, same pattern as the System Access call below.

      if (orgForm.designation !== (orgTarget.designation || "")) {
        await api.put(`/employees/${orgTarget.id}`, {
          fullName: orgTarget.full_name,
          email: orgTarget.email,
          designation: orgForm.designation,
        });
      }

      await api.put(`/organization/users/${orgTarget.id}/transfer`, {
        departmentId: orgForm.departmentId || null,
        reportingManagerId: orgForm.reportingManagerId || null,
      });

      if (
        canManageSystemAccess &&
        orgForm.systemAccess !== (orgTarget.system_access || "employee")
      ) {
        await api.patch(`/organization/users/${orgTarget.id}/system-access`, {
          systemAccess: orgForm.systemAccess,
        });
      }

      if (
        canManageSystemAccess &&
        orgForm.projectAccess !== (orgTarget.project_access_override || "default")
      ) {
        await api.patch(`/organization/users/${orgTarget.id}/project-access`, {
          projectAccess: orgForm.projectAccess,
        });
      }

      if (
        canManageSystemAccess &&
        orgForm.projectAccessLevel !== (orgTarget.project_access_level || "basic")
      ) {
        await api.patch(`/organization/users/${orgTarget.id}/project-access-level`, {
          accessLevel: orgForm.projectAccessLevel,
        });
      }

      toast.success("Organization details updated successfully");

      setOrgTarget(null);

      await loadEmployees();

    } catch (error) {

      toast.error(
        error.response?.data?.message || "Unable to update organization details"
      );

    } finally {

      setOrgSaving(false);

    }

  };

  // ========================================
  // GET EMPLOYEE PHOTO
  // ========================================

  const getEmployeePhoto =
    (employee) => {

      if (
        !employee
          ?.profile_photo
      ) {
        return null;
      }

      if (
        employee
          .profile_photo
          .startsWith(
            "http"
          )
      ) {
        return employee
          .profile_photo;
      }

      return `${BACKEND_URL}${employee.profile_photo}`;
    };

  // ========================================
  // FORMAT DATE
  // ========================================

  const formatDate =
    (value) => {

      if (!value) {
        return "Not provided";
      }

      const date =
        new Date(value);

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        return "Not provided";
      }

      return date.toLocaleDateString(
        "en-IN",
        {
          day:
            "2-digit",
          month:
            "long",
          year:
            "numeric",
        }
      );
    };

  // ========================================
  // HANDLE FORM CHANGE
  // ========================================

  const handleChange =
    (event) => {

      const {
        name,
        value,
      } =
        event.target;

      setFormData(
        (
          previous
        ) => ({
          ...previous,

          [name]:
            value,
        })
      );
    };

  // ========================================
  // CREATE EMPLOYEE
  // ========================================

  const handleSubmit =
    async (
      event
    ) => {

      event.preventDefault();

      if (
        !formData.employeeId ||
        generatingId
      ) {
        toast.error(
          "Employee ID is still being generated, please wait a moment"
        );

        return;
      }

      try {

        setSaving(true);

        // formData.employeeId is sent along as a hint, but the
        // backend never trusts it — it independently generates the
        // real employee_id at creation time (see
        // createEmployee/generateNextEmployeeId server-side).

        await api.post(
          "/employees",
          formData
        );

        toast.success(
          "Employee created successfully"
        );

        setFormData({
          employeeId: "",
          fullName: "",
          email: "",
          designation: "",
          password: "",
          departmentId: "",
          reportingManagerId: "",
          systemAccess: "employee",
        });

        setShowForm(
          false
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to create employee"
        );

      } finally {

        setSaving(false);

      }
    };

  // ========================================
  // EDIT EMPLOYEE
  // ========================================

  const handleEditEmployee =
    async (
      employee
    ) => {

      const fullName =
        window.prompt(
          "Enter employee full name:",
          employee.full_name
        );

      if (!fullName) {
        return;
      }

      const email =
        window.prompt(
          "Enter employee email:",
          employee.email ||
            ""
        );

      if (!email) {
        return;
      }

      // Designation is admin-only editable (never the employee's
      // own My Profile page — that endpoint ignores this field
      // entirely). Employee ID is intentionally not prompted here:
      // it's generated once at creation and stays stable.

      const designation =
        window.prompt(
          "Enter employee designation:",
          employee.designation ||
            ""
        );

      if (!designation) {
        return;
      }

      try {

        await api.put(
          `/employees/${employee.id}`,
          {
            fullName,
            email,
            designation,
          }
        );

        toast.success(
          "Employee updated successfully"
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to update employee"
        );
      }
    };

  // ========================================
  // CHANGE EMPLOYEE STATUS
  // ========================================

  const handleStatusChange =
    async (
      employee
    ) => {

      const newStatus =
        employee.status ===
        "active"
          ? "inactive"
          : "active";

      try {

        await api.patch(
          `/employees/${employee.id}/status`,
          {
            status:
              newStatus,
          }
        );

        toast.success(
          newStatus ===
            "active"
            ? "Employee activated"
            : "Employee deactivated"
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to update employee status"
        );
      }
    };

  // ========================================
  // FORMER-EMPLOYEE / TYPE HELPERS
  // ========================================

  const employmentStatusOf =
    (employee) =>
      // Existing employees are treated as
      // "active" if the column isn't in the
      // API response yet (i.e. the migration
      // for this feature hasn't been run) —
      // same rule the backend applies via its
      // own column default.
      employee.employment_status ||
      "active";

  const employmentTypeOf =
    (employee) =>
      employee.employment_type ||
      "employee";

  const isInternType =
    (employee) =>
      employmentTypeOf(
        employee
      ) === "intern";

  // Covers every terminal status either an
  // employee or an intern can end up in.
  // "converted" is included defensively — in
  // practice a converted person's LIVE record
  // becomes employment_type:'employee',
  // employment_status:'active' (only their
  // closed history period says 'converted').

  const isFormerEmployee =
    (employee) =>
      [
        "resigned",
        "terminated",
        "completed",
        "discontinued",
        "converted",
      ].includes(
        employmentStatusOf(
          employee
        )
      );

  // ========================================
  // VIEW EMPLOYEE (+ LOAD EMPLOYMENT HISTORY)
  // ========================================

  const loadEmploymentHistory =
    async (
      employeeId
    ) => {
      try {

        setHistoryLoading(
          true
        );

        const response =
          await api.get(
            `/employees/${employeeId}/employment-history`
          );

        setEmploymentHistory(
          response.data
            .history || []
        );

      } catch (error) {

        console.error(
          "Load Employment History Error:",
          error
        );

        setEmploymentHistory(
          []
        );

      } finally {

        setHistoryLoading(
          false
        );

      }
    };

  const handleViewEmployee =
    (employee) => {

      setSelectedEmployee(
        employee
      );

      loadEmploymentHistory(
        employee.id
      );

    };

  // ========================================
  // RESIGN / TERMINATE MODALS
  // ========================================

  const openResignModal =
    (employee) => {

      setLifecycleForm({
        lastWorkingDate: "",
        reason: "",
        exitNotes: "",
      });

      setResignTarget(
        employee
      );

    };

  const openTerminateModal =
    (employee) => {

      setLifecycleForm({
        lastWorkingDate: "",
        reason: "",
        exitNotes: "",
      });

      setTerminateTarget(
        employee
      );

    };

  const handleLifecycleFieldChange =
    (event) => {

      const {
        name,
        value,
      } = event.target;

      setLifecycleForm(
        (previous) => ({
          ...previous,
          [name]: value,
        })
      );

    };

  const handleConfirmResign =
    async (event) => {

      event.preventDefault();

      if (
        !lifecycleForm.lastWorkingDate
      ) {
        toast.error(
          "Last working date is required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        await api.post(
          `/employees/${resignTarget.id}/resign`,
          {
            lastWorkingDate:
              lifecycleForm.lastWorkingDate,
            resignationReason:
              lifecycleForm.reason,
            exitNotes:
              lifecycleForm.exitNotes,
          }
        );

        toast.success(
          "Employee marked as resigned successfully"
        );

        setResignTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to mark employee as resigned"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  const handleConfirmTerminate =
    async (event) => {

      event.preventDefault();

      if (
        !lifecycleForm.lastWorkingDate
      ) {
        toast.error(
          "Last working date is required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        await api.post(
          `/employees/${terminateTarget.id}/terminate`,
          {
            lastWorkingDate:
              lifecycleForm.lastWorkingDate,
            terminationReason:
              lifecycleForm.reason,
            exitNotes:
              lifecycleForm.exitNotes,
          }
        );

        toast.success(
          "Employee terminated successfully"
        );

        setTerminateTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to terminate employee"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  // ========================================
  // REHIRE MODAL
  // ========================================

  const openRehireModal =
    (employee) => {

      setRehireForm({
        designation:
          employee.designation ||
          "",
        joiningDate:
          new Date()
            .toISOString()
            .slice(0, 10),
        notes: "",
      });

      setRehireTarget(
        employee
      );

    };

  const handleRehireFieldChange =
    (event) => {

      const {
        name,
        value,
      } = event.target;

      setRehireForm(
        (previous) => ({
          ...previous,
          [name]: value,
        })
      );

    };

  const handleConfirmRehire =
    async (event) => {

      event.preventDefault();

      if (
        !rehireForm.designation.trim() ||
        !rehireForm.joiningDate
      ) {
        toast.error(
          "Designation and joining date are required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        await api.post(
          `/employees/${rehireTarget.id}/rehire`,
          {
            designation:
              rehireForm.designation,
            joiningDate:
              rehireForm.joiningDate,
            notes:
              rehireForm.notes,
          }
        );

        toast.success(
          "Employee rehired successfully"
        );

        setRehireTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to rehire employee"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  // ========================================
  // COMPLETE INTERNSHIP MODAL
  // Reuses lifecycleForm (lastWorkingDate ->
  // completionDate, exitNotes ->
  // completionNotes) — there is no separate
  // "reason" field for a successful completion.
  // ========================================

  const openCompleteModal =
    (employee) => {

      setLifecycleForm({
        lastWorkingDate: "",
        reason: "",
        exitNotes: "",
      });

      setCompleteTarget(
        employee
      );

    };

  const handleConfirmComplete =
    async (event) => {

      event.preventDefault();

      if (
        !lifecycleForm.lastWorkingDate
      ) {
        toast.error(
          "Completion date is required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        await api.post(
          `/employees/${completeTarget.id}/complete-internship`,
          {
            completionDate:
              lifecycleForm.lastWorkingDate,
            completionNotes:
              lifecycleForm.exitNotes,
          }
        );

        toast.success(
          "Internship marked as completed successfully"
        );

        setCompleteTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to complete internship"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  // ========================================
  // DISCONTINUE INTERNSHIP MODAL
  // ========================================

  const openDiscontinueModal =
    (employee) => {

      setLifecycleForm({
        lastWorkingDate: "",
        reason: "",
        exitNotes: "",
      });

      setDiscontinueTarget(
        employee
      );

    };

  const handleConfirmDiscontinue =
    async (event) => {

      event.preventDefault();

      if (
        !lifecycleForm.lastWorkingDate
      ) {
        toast.error(
          "Last working date is required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        await api.post(
          `/employees/${discontinueTarget.id}/discontinue-internship`,
          {
            lastWorkingDate:
              lifecycleForm.lastWorkingDate,
            reason:
              lifecycleForm.reason,
            notes:
              lifecycleForm.exitNotes,
          }
        );

        toast.success(
          "Internship discontinued successfully"
        );

        setDiscontinueTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to discontinue internship"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  // ========================================
  // CONVERT INTERN TO EMPLOYEE MODAL
  // Also used for "Hire as Employee" on a
  // former intern — same endpoint, same form.
  // Reuses rehireForm (designation/joiningDate/
  // notes).
  // ========================================

  const openConvertModal =
    (employee) => {

      setRehireForm({
        designation:
          employee.designation ||
          "",
        joiningDate:
          new Date()
            .toISOString()
            .slice(0, 10),
        notes: "",
      });

      setConvertTarget(
        employee
      );

    };

  const handleConfirmConvert =
    async (event) => {

      event.preventDefault();

      if (
        !rehireForm.designation.trim() ||
        !rehireForm.joiningDate
      ) {
        toast.error(
          "Designation and joining date are required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        const response =
          await api.post(
            `/employees/${convertTarget.id}/convert-to-employee`,
            {
              designation:
                rehireForm.designation,
              joiningDate:
                rehireForm.joiningDate,
              notes:
                rehireForm.notes,
            }
          );

        toast.success(
          response.data
            ?.message ||
            "Intern converted to employee successfully"
        );

        setConvertTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to convert intern to employee"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  // ========================================
  // REHIRE INTERN MODAL
  // Reuses rehireForm — same field shape as
  // Rehire Employee / Convert.
  // ========================================

  const openRehireInternModal =
    (employee) => {

      setRehireForm({
        designation:
          employee.designation ||
          "",
        joiningDate:
          new Date()
            .toISOString()
            .slice(0, 10),
        notes: "",
      });

      setRehireInternTarget(
        employee
      );

    };

  const handleConfirmRehireIntern =
    async (event) => {

      event.preventDefault();

      if (
        !rehireForm.designation.trim() ||
        !rehireForm.joiningDate
      ) {
        toast.error(
          "Designation and joining date are required"
        );

        return;
      }

      try {

        setLifecycleSaving(
          true
        );

        await api.post(
          `/employees/${rehireInternTarget.id}/rehire-intern`,
          {
            designation:
              rehireForm.designation,
            joiningDate:
              rehireForm.joiningDate,
            notes:
              rehireForm.notes,
          }
        );

        toast.success(
          "Intern rehired successfully"
        );

        setRehireInternTarget(
          null
        );

        await loadEmployees();

      } catch (error) {

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to rehire intern"
        );

      } finally {

        setLifecycleSaving(
          false
        );

      }

    };

  // ========================================
  // FILTERED LIST FOR THE ACTIVE TAB
  // ========================================

  const visibleEmployees =
    employees.filter(
      (employee) => {

        const active =
          employmentStatusOf(
            employee
          ) === "active";

        const former =
          isFormerEmployee(
            employee
          );

        const intern =
          isInternType(
            employee
          );

        if (
          activeTab ===
          "activeEmployees"
        ) {
          return (
            active && !intern
          );
        }

        if (
          activeTab ===
          "activeInterns"
        ) {
          return (
            active && intern
          );
        }

        if (
          activeTab ===
          "formerEmployees"
        ) {
          return (
            former && !intern
          );
        }

        if (
          activeTab ===
          "formerInterns"
        ) {
          return (
            former && intern
          );
        }

        return true;

      }
    );

  // ========================================
  // PAGE
  // ========================================

  return (
    
        <>
        <div className="employees-content">

          {/* PAGE HEADER */}

          <div className="employees-page-header">

            <div>

             <h2 style={{ color: "#17211D" }}>
  Employee Management
</h2>

       <p style={{ color: "#64748B" }}>
  View employee profiles, photos and manage employee accounts.
</p>

            </div>

            <div className="employees-header-actions">

              <button
                type="button"
                className="add-employee-button"
                onClick={
                  handleOpenAddEmployee
                }
              >
                <FaPlus />

                Add Employee
              </button>

              <button
                type="button"
                className="add-intern-button"
                onClick={
                  handleOpenAddIntern
                }
              >
                <FaGraduationCap />

                Add Intern
              </button>

            </div>

          </div>

          {/* SUMMARY */}

          <div className="employees-summary">

            <div className="employees-summary-icon">
              <FaUsers />
            </div>

            <div>

              <p>
                Total Employees
              </p>

              <h3>
                {
                  employees.length
                }
              </h3>

            </div>

          </div>

          {/* EMPLOYEE/INTERN LIFECYCLE FILTER TABS */}
          {/* Counts are always derived from the already-loaded
              `employees` list (from the backend), never hardcoded. */}

          <div className="employee-tabs">

            <button
              type="button"
              className={
                activeTab ===
                "activeEmployees"
                  ? "employee-tab active"
                  : "employee-tab"
              }
              onClick={() =>
                setActiveTab(
                  "activeEmployees"
                )
              }
            >
              Active Employees
              {" "}
              (
              {
                employees.filter(
                  (employee) =>
                    employmentStatusOf(
                      employee
                    ) ===
                    "active" &&
                    !isInternType(
                      employee
                    )
                ).length
              }
              )
            </button>

            <button
              type="button"
              className={
                activeTab ===
                "activeInterns"
                  ? "employee-tab active"
                  : "employee-tab"
              }
              onClick={() =>
                setActiveTab(
                  "activeInterns"
                )
              }
            >
              Active Interns
              {" "}
              (
              {
                employees.filter(
                  (employee) =>
                    employmentStatusOf(
                      employee
                    ) ===
                    "active" &&
                    isInternType(
                      employee
                    )
                ).length
              }
              )
            </button>

            <button
              type="button"
              className={
                activeTab ===
                "formerEmployees"
                  ? "employee-tab active"
                  : "employee-tab"
              }
              onClick={() =>
                setActiveTab(
                  "formerEmployees"
                )
              }
            >
              Former Employees
              {" "}
              (
              {
                employees.filter(
                  (employee) =>
                    isFormerEmployee(
                      employee
                    ) &&
                    !isInternType(
                      employee
                    )
                ).length
              }
              )
            </button>

            <button
              type="button"
              className={
                activeTab ===
                "formerInterns"
                  ? "employee-tab active"
                  : "employee-tab"
              }
              onClick={() =>
                setActiveTab(
                  "formerInterns"
                )
              }
            >
              Former Interns
              {" "}
              (
              {
                employees.filter(
                  (employee) =>
                    isFormerEmployee(
                      employee
                    ) &&
                    isInternType(
                      employee
                    )
                ).length
              }
              )
            </button>

            <button
              type="button"
              className={
                activeTab ===
                "all"
                  ? "employee-tab active"
                  : "employee-tab"
              }
              onClick={() =>
                setActiveTab(
                  "all"
                )
              }
            >
              All
              {" "}
              (
              {
                employees.length
              }
              )
            </button>

          </div>

          {/* EMPLOYEE TABLE */}

          <div className="employees-table-card">

            <div className="employees-table-header">

              <h3>
                {activeTab ===
                "activeEmployees"
                  ? "Active Employees"
                  : activeTab ===
                    "activeInterns"
                  ? "Active Interns"
                  : activeTab ===
                    "formerEmployees"
                  ? "Former Employees"
                  : activeTab ===
                    "formerInterns"
                  ? "Former Interns"
                  : "All Employees & Interns"}
              </h3>

              <span>

                {
                  visibleEmployees.length
                }{" "}

                employee

                {visibleEmployees.length !==
                1
                  ? "s"
                  : ""}

              </span>

            </div>

            {loading ? (

              <div className="employees-empty">

                Loading
                employees...

              </div>

            ) : visibleEmployees.length ===
              0 ? (

              <div className="employees-empty">

                {activeTab ===
                "formerEmployees"
                  ? "No former employees."
                  : activeTab ===
                    "formerInterns"
                  ? "No former interns."
                  : activeTab ===
                    "activeInterns"
                  ? "No active interns."
                  : "No employees found."}

              </div>

            ) : (

              <div className="employees-table-wrapper">

                <table className="employees-table">

                  <thead>

                    <tr>

                      <th>
                        Employee
                      </th>

                      <th>
                        ID
                      </th>

                      <th>
                        Type
                      </th>

                      <th>
                        Email
                      </th>

                      <th>
                        Designation
                      </th>

                      <th>
                        Status
                      </th>

                      <th>
                        Last Login
                      </th>

                      <th>
                        Actions
                      </th>

                    </tr>

                  </thead>

                  <tbody>

                    {visibleEmployees.map(
                      (
                        employee
                      ) => {

                        const photoUrl =
                          getEmployeePhoto(
                            employee
                          );

                        const employmentStatus =
                          employmentStatusOf(
                            employee
                          );

                        const former =
                          isFormerEmployee(
                            employee
                          );

                        const intern =
                          isInternType(
                            employee
                          );

                        return (

                          <tr
                            key={
                              employee.id
                            }
                          >

                            {/* EMPLOYEE */}

                            <td>

                              <div className="employee-name-cell">

                                <div
                                  className="table-avatar"
                                  style={{
                                    overflow:
                                      "hidden",
                                  }}
                                >

                                  {photoUrl ? (

                                    <img
                                      src={
                                        photoUrl
                                      }
                                      alt={
                                        employee.full_name
                                      }
                                      style={{
                                        width:
                                          "100%",
                                        height:
                                          "100%",
                                        objectFit:
                                          "cover",
                                        borderRadius:
                                          "50%",
                                        display:
                                          "block",
                                      }}
                                    />

                                  ) : (

                                    employee
                                      .full_name
                                      ?.charAt(
                                        0
                                      )
                                      .toUpperCase() ||
                                    "E"

                                  )}

                                </div>

                                <span>

                                  {
                                    employee
                                      .full_name
                                  }

                                </span>

                              </div>

                            </td>

                            {/* EMPLOYEE/INTERN ID */}

                            <td>

                              {
                                employee
                                  .employee_id
                              }

                            </td>

                            {/* TYPE BADGE */}

                            <td>

                              <span
                                className={
                                  intern
                                    ? "employment-type-badge intern"
                                    : "employment-type-badge employee"
                                }
                              >

                                {intern ? (
                                  <FaGraduationCap />
                                ) : (
                                  <FaUserTie />
                                )}

                                {intern
                                  ? "Intern"
                                  : "Employee"}

                              </span>

                            </td>

                            {/* EMAIL */}

                            <td>

                              {employee
                                .email ||
                                "Not provided"}

                            </td>

                            {/* DESIGNATION */}

                            <td>

                              {employee
                                .designation ||
                                "Not provided"}

                            </td>

                            {/* EMPLOYMENT STATUS */}

                            <td>

                              <span
                                className={`employment-status-badge ${employmentStatus}`}
                              >

                                {
                                  employmentStatus
                                }

                              </span>

                            </td>

                            {/* LAST LOGIN */}

                            <td>

                              {employee
                                .last_login
                                ? new Date(
                                    employee.last_login
                                  ).toLocaleString(
                                    "en-IN"
                                  )
                                : "Never"}

                            </td>

                            {/* ACTIONS */}

                            <td>

                              <div className="employee-actions">

                                {/* VIEW DETAILS (always available) */}

                                <button
                                  type="button"
                                  className="view-employee-action"
                                  onClick={() =>
                                    handleViewEmployee(
                                      employee
                                    )
                                  }
                                  title={
                                    former
                                      ? "View Employee History"
                                      : "View Employee Details"
                                  }
                                >
                                  <FaEye />
                                </button>

                                {former && !intern && (

                                  /* FORMER EMPLOYEE: rehire only */

                                  <button
                                    type="button"
                                    className="rehire-employee-action"
                                    onClick={() =>
                                      openRehireModal(
                                        employee
                                      )
                                    }
                                    title="Rehire Employee"
                                  >
                                    <FaUserPlus />
                                  </button>

                                )}

                                {former && intern && (

                                  /* FORMER INTERN: rehire as intern, or hire as employee */

                                  <>

                                    <button
                                      type="button"
                                      className="rehire-employee-action"
                                      onClick={() =>
                                        openRehireInternModal(
                                          employee
                                        )
                                      }
                                      title="Rehire as Intern"
                                    >
                                      <FaUserPlus />
                                    </button>

                                    <button
                                      type="button"
                                      className="convert-employee-action"
                                      onClick={() =>
                                        openConvertModal(
                                          employee
                                        )
                                      }
                                      title="Hire as Employee"
                                    >
                                      <FaLevelUpAlt />
                                    </button>

                                  </>

                                )}

                                {!former && !intern && (

                                  /* ACTIVE EMPLOYEE */

                                  <>

                                    {/* EDIT */}

                                    <button
                                      type="button"
                                      className="edit-employee-action"
                                      onClick={() =>
                                        handleEditEmployee(
                                          employee
                                        )
                                      }
                                      title="Edit Employee"
                                    >
                                      <FaEdit />
                                    </button>

                                    {/* ORGANIZATION (department / reporting manager / system access) */}

                                    <button
                                      type="button"
                                      className="organization-action-button"
                                      onClick={() =>
                                        openOrgModal(
                                          employee
                                        )
                                      }
                                      title="Department, Reporting Manager & Access"
                                    >
                                      <FaSitemap />
                                    </button>

                                    {/* ACCOUNT STATUS (existing activate/deactivate toggle) */}

                                    <button
                                      type="button"
                                      className={
                                        employee.status ===
                                        "active"
                                          ? "deactivate-employee-action"
                                          : "activate-employee-action"
                                      }
                                      onClick={() =>
                                        handleStatusChange(
                                          employee
                                        )
                                      }
                                      title={
                                        employee.status ===
                                        "active"
                                          ? "Deactivate Employee"
                                          : "Activate Employee"
                                      }
                                    >

                                      {employee.status ===
                                      "active" ? (

                                        <FaUserSlash />

                                      ) : (

                                        <FaUserCheck />

                                      )}

                                    </button>

                                    {/* MARK AS RESIGNED */}

                                    <button
                                      type="button"
                                      className="resign-employee-action"
                                      onClick={() =>
                                        openResignModal(
                                          employee
                                        )
                                      }
                                      title="Mark as Resigned"
                                    >
                                      <FaSignOutAlt />
                                    </button>

                                    {/* TERMINATE */}

                                    <button
                                      type="button"
                                      className="terminate-employee-action"
                                      onClick={() =>
                                        openTerminateModal(
                                          employee
                                        )
                                      }
                                      title="Terminate Employee"
                                    >
                                      <FaBan />
                                    </button>

                                  </>

                                )}

                                {!former && intern && (

                                  /* ACTIVE INTERN */

                                  <>

                                    {/* EDIT */}

                                    <button
                                      type="button"
                                      className="edit-employee-action"
                                      onClick={() =>
                                        handleEditEmployee(
                                          employee
                                        )
                                      }
                                      title="Edit Intern"
                                    >
                                      <FaEdit />
                                    </button>

                                    {/* ORGANIZATION (department / reporting manager / access) */}

                                    <button
                                      type="button"
                                      className="organization-action-button"
                                      onClick={() =>
                                        openOrgModal(
                                          employee
                                        )
                                      }
                                      title="Department, Reporting Manager & Access"
                                    >
                                      <FaSitemap />
                                    </button>

                                    {/* COMPLETE INTERNSHIP */}

                                    <button
                                      type="button"
                                      className="complete-internship-action"
                                      onClick={() =>
                                        openCompleteModal(
                                          employee
                                        )
                                      }
                                      title="Complete Internship"
                                    >
                                      <FaCheckCircle />
                                    </button>

                                    {/* DISCONTINUE INTERNSHIP */}

                                    <button
                                      type="button"
                                      className="resign-employee-action"
                                      onClick={() =>
                                        openDiscontinueModal(
                                          employee
                                        )
                                      }
                                      title="Discontinue Internship"
                                    >
                                      <FaSignOutAlt />
                                    </button>

                                    {/* TERMINATE INTERNSHIP (reuses the same employee terminate flow/endpoint) */}

                                    <button
                                      type="button"
                                      className="terminate-employee-action"
                                      onClick={() =>
                                        openTerminateModal(
                                          employee
                                        )
                                      }
                                      title="Terminate Internship"
                                    >
                                      <FaBan />
                                    </button>

                                    {/* CONVERT TO EMPLOYEE */}

                                    <button
                                      type="button"
                                      className="convert-employee-action"
                                      onClick={() =>
                                        openConvertModal(
                                          employee
                                        )
                                      }
                                      title="Convert to Employee"
                                    >
                                      <FaLevelUpAlt />
                                    </button>

                                  </>

                                )}

                              </div>

                            </td>

                          </tr>

                        );
                      }
                    )}

                  </tbody>

                </table>

              </div>

            )}

          </div>

        </div>

      

      {/* ======================================
          ADD EMPLOYEE MODAL
      ====================================== */}

      {showForm && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>

                <h2>
                  Add Employee
                </h2>

                <p>
                  Create a new
                  employee login
                  account.
                </p>

              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setShowForm(
                    false
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleSubmit
              }
            >

              <div className="employee-form-group">

                <label>
                  Employee ID
                </label>

                <input
                  type="text"
                  value={
                    generatingId
                      ? "Generating..."
                      : formData
                          .employeeId
                  }
                  disabled
                />

                <span className="employee-form-help">
                  Employee ID is
                  generated
                  automatically
                </span>

              </div>

              <div className="employee-form-group">

                <label>
                  Full Name
                </label>

                <input
                  type="text"
                  name="fullName"
                  value={
                    formData
                      .fullName
                  }
                  onChange={
                    handleChange
                  }
                  placeholder="Enter employee name"
                  required
                />

              </div>

              <div className="employee-form-group">

                <label>
                  Email Address
                </label>

                <input
                  type="email"
                  name="email"
                  value={
                    formData
                      .email
                  }
                  onChange={
                    handleChange
                  }
                  placeholder="Enter employee email"
                  required
                />

              </div>

              <div className="employee-form-group">

                <label>
                  Designation
                </label>

                <select
                  name="designation"
                  value={
                    formData
                      .designation
                  }
                  onChange={
                    handleChange
                  }
                  required
                >
                  <option value="">Select designation</option>
                  {designationsCatalog.map((designation) => (
                    <option key={designation.id} value={designation.title}>
                      {designation.title}
                    </option>
                  ))}
                </select>

              </div>

              <div className="employee-form-group">

                <label>
                  Department
                </label>

                <select
                  name="departmentId"
                  value={
                    formData
                      .departmentId
                  }
                  onChange={
                    handleChange
                  }
                >
                  <option value="">Not assigned</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>

              </div>

              <div className="employee-form-group">

                <label>
                  Reporting Manager
                </label>

                <select
                  name="reportingManagerId"
                  value={
                    formData
                      .reportingManagerId
                  }
                  onChange={
                    handleChange
                  }
                >
                  <option value="">Not assigned</option>
                  {employees
                    .filter((candidate) => candidate.employment_status === "active")
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.full_name} ({candidate.employee_id})
                      </option>
                    ))}
                </select>

              </div>

              {canManageSystemAccess && (

                <div className="employee-form-group">

                  <label>
                    System Access
                  </label>

                  <select
                    name="systemAccess"
                    value={
                      formData
                        .systemAccess
                    }
                    onChange={
                      handleChange
                    }
                  >
                    <option value="employee">Employee</option>
                    <option value="team_lead">Team Lead</option>
                    <option value="manager">Manager</option>
                    <option value="department_head">Department Head</option>
                    <option value="hr">HR</option>
                    <option value="executive">Executive</option>
                    <option value="admin">Admin</option>
                    {currentUser?.systemAccess === "super_admin" && (
                      <option value="super_admin">Super Admin</option>
                    )}
                  </select>

                  <span className="employee-form-help">
                    Defaults to Employee. Determines what this person can
                    see/do — separate from their job designation.
                  </span>

                </div>

              )}

              <div className="employee-form-group">

                <label>
                  Temporary Password
                </label>

                <input
                  type="password"
                  name="password"
                  value={
                    formData
                      .password
                  }
                  onChange={
                    handleChange
                  }
                  placeholder="Create temporary password"
                  required
                />

              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setShowForm(
                      false
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    saving
                  }
                >

                  {saving
                    ? "Creating..."
                    : "Create Employee"}

                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          ADD INTERN MODAL
      ====================================== */}

      {showInternForm && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>

                <h2>
                  Add Intern
                </h2>

                <p>
                  Create a new
                  intern login
                  account.
                </p>

              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setShowInternForm(
                    false
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleSubmitIntern
              }
            >

              <div className="employee-form-group">

                <label>
                  Intern ID
                </label>

                <input
                  type="text"
                  value={
                    generatingInternId
                      ? "Generating..."
                      : internFormData
                          .internId
                  }
                  disabled
                />

                <span className="employee-form-help">
                  Intern ID is
                  generated
                  automatically
                </span>

              </div>

              <div className="employee-form-group">

                <label>
                  Full Name
                </label>

                <input
                  type="text"
                  name="fullName"
                  value={
                    internFormData
                      .fullName
                  }
                  onChange={
                    handleInternFormChange
                  }
                  placeholder="Enter intern name"
                  required
                />

              </div>

              <div className="employee-form-group">

                <label>
                  Email Address
                </label>

                <input
                  type="email"
                  name="email"
                  value={
                    internFormData
                      .email
                  }
                  onChange={
                    handleInternFormChange
                  }
                  placeholder="Enter intern email"
                  required
                />

              </div>

              <div className="employee-form-group">

                <label>
                  Internship Role /
                  Designation
                </label>

                <select
                  name="designation"
                  value={
                    internFormData
                      .designation
                  }
                  onChange={
                    handleInternFormChange
                  }
                  required
                >
                  <option value="">Select designation</option>
                  {designationsCatalog.map((designation) => (
                    <option key={designation.id} value={designation.title}>
                      {designation.title}
                    </option>
                  ))}
                </select>

              </div>

              <div className="employee-form-group">

                <label>
                  Department
                </label>

                <select
                  name="departmentId"
                  value={
                    internFormData
                      .departmentId
                  }
                  onChange={
                    handleInternFormChange
                  }
                >
                  <option value="">Not assigned</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>

              </div>

              <div className="employee-form-group">

                <label>
                  Reporting Manager
                </label>

                <select
                  name="reportingManagerId"
                  value={
                    internFormData
                      .reportingManagerId
                  }
                  onChange={
                    handleInternFormChange
                  }
                >
                  <option value="">Not assigned</option>
                  {employees
                    .filter((candidate) => candidate.employment_status === "active")
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.full_name} ({candidate.employee_id})
                      </option>
                    ))}
                </select>

                <span className="employee-form-help">
                  Separate from Mentor below — the reporting manager
                  drives the org chart and leave approval routing.
                </span>

              </div>

              <div className="employee-form-group">

                <label>
                  Mentor / Reporting
                  Manager
                </label>

                <select
                  name="mentorId"
                  value={
                    internFormData
                      .mentorId
                  }
                  onChange={
                    handleInternFormChange
                  }
                >
                  <option value="">
                    Not assigned
                  </option>

                  {employees
                    .filter(
                      (candidate) =>
                        !isFormerEmployee(
                          candidate
                        )
                    )
                    .map(
                      (
                        candidate
                      ) => (
                        <option
                          key={
                            candidate.id
                          }
                          value={
                            candidate.id
                          }
                        >
                          {
                            candidate.full_name
                          }
                          {" ("}
                          {
                            candidate.employee_id
                          }
                          {")"}
                        </option>
                      )
                    )}
                </select>

              </div>

              <div className="employee-form-group">

                <label>
                  Temporary Password
                </label>

                <input
                  type="password"
                  name="password"
                  value={
                    internFormData
                      .password
                  }
                  onChange={
                    handleInternFormChange
                  }
                  placeholder="Create temporary password"
                  required
                />

              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setShowInternForm(
                      false
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    saving
                  }
                >

                  {saving
                    ? "Creating..."
                    : "Create Intern"}

                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          EMPLOYEE DETAILS MODAL
      ====================================== */}

      {selectedEmployee && (

        <div className="employee-modal-overlay">

          <div className="employee-modal employee-details-modal">

            <div className="employee-modal-header">

              <div>

                <h2>
                  Employee Details
                </h2>

                <p>
                  Complete employee
                  profile information.
                </p>

              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setSelectedEmployee(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            {isFormerEmployee(
              selectedEmployee
            ) && (

              <div className="former-employee-banner">
                <FaBan />
                {isInternType(
                  selectedEmployee
                )
                  ? "Former Intern"
                  : "Former Employee"}
                {" — "}
                {employmentStatusOf(
                  selectedEmployee
                )}
              </div>

            )}

            {/* PROFILE PHOTO */}

            <div
              style={{
                display:
                  "flex",
                justifyContent:
                  "center",
                marginBottom:
                  "24px",
              }}
            >

              <div
                style={{
                  width:
                    "110px",
                  height:
                    "110px",
                  borderRadius:
                    "50%",
                  overflow:
                    "hidden",
                  display:
                    "flex",
                  alignItems:
                    "center",
                  justifyContent:
                    "center",
                  fontSize:
                    "38px",
                  fontWeight:
                    "700",
                  background:
                    "#EAF3FF",
                }}
              >

                {getEmployeePhoto(
                  selectedEmployee
                ) ? (

                  <img
                    src={getEmployeePhoto(
                      selectedEmployee
                    )}
                    alt={
                      selectedEmployee
                        .full_name
                    }
                    style={{
                      width:
                        "100%",
                      height:
                        "100%",
                      objectFit:
                        "cover",
                    }}
                  />

                ) : (

                  selectedEmployee
                    .full_name
                    ?.charAt(
                      0
                    )
                    .toUpperCase() ||
                  "E"

                )}

              </div>

            </div>

            {/* DETAILS */}

            <div className="employee-details-grid">

              <div className="employee-detail-item">

                <FaIdBadge />

                <div>
                  <span>
                    {isInternType(
                      selectedEmployee
                    )
                      ? "Intern ID"
                      : "Employee ID"}
                  </span>

                  <strong>
                    {selectedEmployee
                      .employee_id ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaUsers />

                <div>
                  <span>
                    Full Name
                  </span>

                  <strong>
                    {selectedEmployee
                      .full_name ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaEnvelope />

                <div>
                  <span>
                    Email
                  </span>

                  <strong>
                    {selectedEmployee
                      .email ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaPhone />

                <div>
                  <span>
                    Phone
                  </span>

                  <strong>
                    {selectedEmployee
                      .phone ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaBriefcase />

                <div>
                  <span>
                    Designation
                  </span>

                  <strong>
                    {selectedEmployee
                      .designation ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaBirthdayCake />

                <div>
                  <span>
                    Date of Birth
                  </span>

                  <strong>
                    {formatDate(
                      selectedEmployee
                        .date_of_birth
                    )}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaPhoneAlt />

                <div>
                  <span>
                    Emergency Contact
                  </span>

                  <strong>
                    {selectedEmployee
                      .emergency_contact ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaUserCheck />

                <div>
                  <span>
                    Account Status
                  </span>

                  <strong>
                    {selectedEmployee
                      .status ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaUsers />

                <div>
                  <span>
                    Employment Status
                  </span>

                  <strong>
                    {employmentStatusOf(
                      selectedEmployee
                    )}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaBuilding />

                <div>
                  <span>
                    Department
                  </span>

                  <strong>
                    {selectedEmployee
                      .department_name ||
                      "Not assigned"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaUserTie />

                <div>
                  <span>
                    Reporting Manager
                  </span>

                  <strong>
                    {selectedEmployee
                      .reporting_manager_name
                      ? `${selectedEmployee.reporting_manager_name} (${selectedEmployee.reporting_manager_employee_id})`
                      : "Not assigned"}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaSitemap />

                <div>
                  <span>
                    System Access
                  </span>

                  <strong>
                    {(selectedEmployee.system_access || "employee").replace("_", " ")}
                  </strong>
                </div>

              </div>

              <div className="employee-detail-item">

                <FaCalendarAlt />

                <div>
                  <span>
                    Joining Date
                  </span>

                  <strong>
                    {formatDate(
                      selectedEmployee
                        .joining_date
                    )}
                  </strong>
                </div>

              </div>

              {isInternType(
                selectedEmployee
              ) && (

                <>

                  <div className="employee-detail-item">

                    <FaCalendarAlt />

                    <div>
                      <span>
                        Internship End
                        Date
                      </span>

                      <strong>
                        {formatDate(
                          selectedEmployee
                            .internship_end_date
                        )}
                      </strong>
                    </div>

                  </div>

                  <div className="employee-detail-item">

                    <FaUserTie />

                    <div>
                      <span>
                        Mentor /
                        Reporting
                        Manager
                      </span>

                      <strong>
                        {selectedEmployee
                          .mentor_name ||
                          "Not provided"}
                      </strong>
                    </div>

                  </div>

                  <div className="employee-detail-item">

                    <FaMoneyBillWave />

                    <div>
                      <span>
                        Stipend
                      </span>

                      <strong>
                        {selectedEmployee
                          .stipend !=
                        null
                          ? selectedEmployee.stipend
                          : "Not provided"}
                      </strong>
                    </div>

                  </div>

                </>

              )}

              {isFormerEmployee(
                selectedEmployee
              ) && (

                <>

                  <div className="employee-detail-item">

                    <FaCalendarAlt />

                    <div>
                      <span>
                        Last Working
                        Date
                      </span>

                      <strong>
                        {formatDate(
                          selectedEmployee
                            .last_working_date
                        )}
                      </strong>
                    </div>

                  </div>

                  <div className="employee-detail-item">

                    <FaHistory />

                    <div>
                      <span>
                        {employmentStatusOf(
                          selectedEmployee
                        ) ===
                        "terminated"
                          ? "Termination Date"
                          : employmentStatusOf(
                              selectedEmployee
                            ) ===
                            "completed"
                          ? "Completion Date"
                          : employmentStatusOf(
                              selectedEmployee
                            ) ===
                            "discontinued"
                          ? "Discontinuation Date"
                          : "Resignation Date"}
                      </span>

                      <strong>
                        {formatDate(
                          selectedEmployee
                            .exited_at
                        )}
                      </strong>
                    </div>

                  </div>

                  <div className="employee-detail-item">

                    <FaHistory />

                    <div>
                      <span>
                        Reason for
                        Leaving
                      </span>

                      <strong>
                        {selectedEmployee
                          .exit_reason ||
                          "Not provided"}
                      </strong>
                    </div>

                  </div>

                  <div className="employee-detail-item employee-detail-address">

                    <FaHistory />

                    <div>
                      <span>
                        Exit Notes
                      </span>

                      <strong>
                        {selectedEmployee
                          .exit_notes ||
                          "Not provided"}
                      </strong>
                    </div>

                  </div>

                </>

              )}

              <div className="employee-detail-item employee-detail-address">

                <FaMapMarkerAlt />

                <div>
                  <span>
                    Address
                  </span>

                  <strong>
                    {selectedEmployee
                      .address ||
                      "Not provided"}
                  </strong>
                </div>

              </div>

            </div>

            {/* EMPLOYMENT HISTORY */}

            <div className="employment-history-section">

              <h3>
                <FaHistory />
                Employment History
              </h3>

              {historyLoading ? (

                <p className="employment-history-empty">
                  Loading employment
                  history...
                </p>

              ) : employmentHistory.length ===
                0 ? (

                <p className="employment-history-empty">
                  No employment
                  history recorded
                  yet.
                </p>

              ) : (

                <div className="employment-history-list">

                  {employmentHistory.map(
                    (
                      period,
                      index
                    ) => (

                      <div
                        key={
                          period.id
                        }
                        className="employment-history-item"
                      >

                        <div className="employment-history-item-header">

                          <strong>
                            Period{" "}
                            {employmentHistory.length -
                              index}

                            {": "}

                            {period.designation ||
                              "Not provided"}
                          </strong>

                          <span
                            className={
                              period.employment_type ===
                              "intern"
                                ? "employment-type-badge intern"
                                : "employment-type-badge employee"
                            }
                          >
                            {period.employment_type ===
                            "intern" ? (
                              <FaGraduationCap />
                            ) : (
                              <FaUserTie />
                            )}
                            {period.employment_type ===
                            "intern"
                              ? "Intern"
                              : "Employee"}
                          </span>

                          <span
                            className={`employment-status-badge ${period.employment_status}`}
                          >
                            {
                              period.employment_status
                            }
                          </span>

                        </div>

                        <p>
                          {period.identifier ||
                            "—"}
                          {" · "}
                          {formatDate(
                            period.start_date
                          )}{" "}
                          →{" "}
                          {period.end_date
                            ? formatDate(
                                period.end_date
                              )
                            : "Present"}
                        </p>

                        {period.exit_reason && (
                          <p className="employment-history-note">
                            Reason:{" "}
                            {
                              period.exit_reason
                            }
                          </p>
                        )}

                        {period.exit_notes && (
                          <p className="employment-history-note">
                            Exit
                            Notes:{" "}
                            {
                              period.exit_notes
                            }
                          </p>
                        )}

                        {period.notes && (
                          <p className="employment-history-note">
                            Notes:{" "}
                            {
                              period.notes
                            }
                          </p>
                        )}

                      </div>

                    )
                  )}

                </div>

              )}

            </div>

            <div className="employee-modal-actions">

              <button
                type="button"
                className="cancel-employee-button"
                onClick={() =>
                  setSelectedEmployee(
                    null
                  )
                }
              >
                Close
              </button>

            </div>

          </div>

        </div>

      )}

      {/* ======================================
          RESIGN EMPLOYEE MODAL
      ====================================== */}

      {resignTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  Mark Employee as
                  Resigned
                </h2>
                <p>
                  This keeps the
                  employee's full
                  profile and history
                  — only their
                  employment status
                  changes.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setResignTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmResign
              }
            >

              <div className="employee-form-group">
                <label>
                  Employee Name
                </label>
                <input
                  type="text"
                  value={
                    resignTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Employee ID
                </label>
                <input
                  type="text"
                  value={
                    resignTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Designation
                </label>
                <input
                  type="text"
                  value={
                    resignTarget.designation ||
                    "Not provided"
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Last Working Date
                </label>
                <input
                  type="date"
                  name="lastWorkingDate"
                  value={
                    lifecycleForm.lastWorkingDate
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Resignation Reason
                </label>
                <textarea
                  name="reason"
                  value={
                    lifecycleForm.reason
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Exit Notes
                </label>
                <textarea
                  name="exitNotes"
                  value={
                    lifecycleForm.exitNotes
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional HR/Admin notes"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setResignTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Resignation"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          TERMINATE EMPLOYEE MODAL
      ====================================== */}

      {terminateTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  {isInternType(
                    terminateTarget
                  )
                    ? "Terminate Internship"
                    : "Terminate Employee"}
                </h2>
                <p>
                  This keeps the
                  full profile and
                  history — only the
                  employment status
                  changes.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setTerminateTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmTerminate
              }
            >

              <div className="employee-form-group">
                <label>
                  Full Name
                </label>
                <input
                  type="text"
                  value={
                    terminateTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  {isInternType(
                    terminateTarget
                  )
                    ? "Intern ID"
                    : "Employee ID"}
                </label>
                <input
                  type="text"
                  value={
                    terminateTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Designation
                </label>
                <input
                  type="text"
                  value={
                    terminateTarget.designation ||
                    "Not provided"
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Last Working Date
                </label>
                <input
                  type="date"
                  name="lastWorkingDate"
                  value={
                    lifecycleForm.lastWorkingDate
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Termination Reason
                </label>
                <textarea
                  name="reason"
                  value={
                    lifecycleForm.reason
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Admin Notes
                </label>
                <textarea
                  name="exitNotes"
                  value={
                    lifecycleForm.exitNotes
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional HR/Admin notes"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setTerminateTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="terminate-confirm-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Termination"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          REHIRE EMPLOYEE MODAL
      ====================================== */}

      {rehireTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  Rehire Employee
                </h2>
                <p>
                  Reactivates this
                  same employee record
                  and Employee ID —
                  their previous
                  employment period
                  stays preserved in
                  history.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setRehireTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmRehire
              }
            >

              <div className="employee-form-group">
                <label>
                  Employee Name
                </label>
                <input
                  type="text"
                  value={
                    rehireTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Employee ID
                </label>
                <input
                  type="text"
                  value={
                    rehireTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  New Designation
                </label>
                <input
                  type="text"
                  name="designation"
                  value={
                    rehireForm.designation
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  placeholder="Example: Senior Software Developer"
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  New Joining Date
                </label>
                <input
                  type="date"
                  name="joiningDate"
                  value={
                    rehireForm.joiningDate
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Notes
                </label>
                <textarea
                  name="notes"
                  value={
                    rehireForm.notes
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setRehireTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Rehire"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          COMPLETE INTERNSHIP MODAL
      ====================================== */}

      {completeTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  Complete Internship
                </h2>
                <p>
                  This keeps the
                  intern's full
                  profile and history
                  — only their
                  internship status
                  changes.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setCompleteTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmComplete
              }
            >

              <div className="employee-form-group">
                <label>
                  Full Name
                </label>
                <input
                  type="text"
                  value={
                    completeTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Intern ID
                </label>
                <input
                  type="text"
                  value={
                    completeTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Designation
                </label>
                <input
                  type="text"
                  value={
                    completeTarget.designation ||
                    "Not provided"
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Completion Date
                </label>
                <input
                  type="date"
                  name="lastWorkingDate"
                  value={
                    lifecycleForm.lastWorkingDate
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Completion Notes
                </label>
                <textarea
                  name="exitNotes"
                  value={
                    lifecycleForm.exitNotes
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setCompleteTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Completion"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          DISCONTINUE INTERNSHIP MODAL
      ====================================== */}

      {discontinueTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  Discontinue
                  Internship
                </h2>
                <p>
                  This keeps the
                  intern's full
                  profile and history
                  — only their
                  internship status
                  changes.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setDiscontinueTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmDiscontinue
              }
            >

              <div className="employee-form-group">
                <label>
                  Full Name
                </label>
                <input
                  type="text"
                  value={
                    discontinueTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Intern ID
                </label>
                <input
                  type="text"
                  value={
                    discontinueTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Designation
                </label>
                <input
                  type="text"
                  value={
                    discontinueTarget.designation ||
                    "Not provided"
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Last Working Date
                </label>
                <input
                  type="date"
                  name="lastWorkingDate"
                  value={
                    lifecycleForm.lastWorkingDate
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Reason
                </label>
                <textarea
                  name="reason"
                  value={
                    lifecycleForm.reason
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Notes
                </label>
                <textarea
                  name="exitNotes"
                  value={
                    lifecycleForm.exitNotes
                  }
                  onChange={
                    handleLifecycleFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setDiscontinueTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="terminate-confirm-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Discontinuation"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          CONVERT INTERN TO EMPLOYEE MODAL
          (also used for "Hire as Employee" on a
          former intern)
      ====================================== */}

      {convertTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  Convert to Employee
                </h2>
                <p>
                  Reuses the SAME
                  WorkHub account —
                  no new login, no
                  duplicate user. A
                  new Employee ID is
                  generated and the
                  previous Intern ID
                  stays visible in
                  history.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setConvertTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmConvert
              }
            >

              <div className="employee-form-group">
                <label>
                  Full Name
                </label>
                <input
                  type="text"
                  value={
                    convertTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Current Intern ID
                </label>
                <input
                  type="text"
                  value={
                    convertTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  New Employee
                  Designation
                </label>
                <input
                  type="text"
                  name="designation"
                  value={
                    rehireForm.designation
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  placeholder="Example: Junior Software Engineer"
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Employee Joining
                  Date
                </label>
                <input
                  type="date"
                  name="joiningDate"
                  value={
                    rehireForm.joiningDate
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Notes
                </label>
                <textarea
                  name="notes"
                  value={
                    rehireForm.notes
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setConvertTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Conversion"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          REHIRE INTERN MODAL
      ====================================== */}

      {rehireInternTarget && (

        <div className="employee-modal-overlay">

          <div className="employee-modal">

            <div className="employee-modal-header">

              <div>
                <h2>
                  Rehire as Intern
                </h2>
                <p>
                  Reactivates this
                  same account and
                  Intern ID — their
                  previous internship
                  period stays
                  preserved in
                  history.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() =>
                  setRehireInternTarget(
                    null
                  )
                }
              >
                <FaTimes />
              </button>

            </div>

            <form
              onSubmit={
                handleConfirmRehireIntern
              }
            >

              <div className="employee-form-group">
                <label>
                  Full Name
                </label>
                <input
                  type="text"
                  value={
                    rehireInternTarget.full_name
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Intern ID
                </label>
                <input
                  type="text"
                  value={
                    rehireInternTarget.employee_id
                  }
                  disabled
                />
              </div>

              <div className="employee-form-group">
                <label>
                  New Internship Role
                </label>
                <input
                  type="text"
                  name="designation"
                  value={
                    rehireForm.designation
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  placeholder="Example: Backend Development Intern"
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  New Start Date
                </label>
                <input
                  type="date"
                  name="joiningDate"
                  value={
                    rehireForm.joiningDate
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>
                  Notes
                </label>
                <textarea
                  name="notes"
                  value={
                    rehireForm.notes
                  }
                  onChange={
                    handleRehireFieldChange
                  }
                  placeholder="Optional"
                  rows="3"
                />
              </div>

              <div className="employee-modal-actions">

                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() =>
                    setRehireInternTarget(
                      null
                    )
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={
                    lifecycleSaving
                  }
                >
                  {lifecycleSaving
                    ? "Saving..."
                    : "Confirm Rehire"}
                </button>

              </div>

            </form>

          </div>

        </div>

      )}

      {/* ======================================
          ORGANIZATION MODAL
          Department + Reporting Manager (one
          transfer operation) and, where
          authorized, System Access.
      ====================================== */}

      {orgTarget && (

        <div className="employee-modal-overlay">
          <div className="employee-modal">

            <div className="employee-modal-header">
              <div>
                <h2>Designation, Department, Reporting Manager & Access</h2>
                <p>{orgTarget.full_name} ({orgTarget.employee_id})</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setOrgTarget(null)}
              >
                <FaTimes />
              </button>
            </div>

            <form onSubmit={handleOrgSubmit}>

              <div className="employee-form-group">
                <label>Designation</label>
                <select
                  name="designation"
                  value={orgForm.designation}
                  onChange={handleOrgFieldChange}
                >
                  <option value="">Not assigned</option>
                  {designationsCatalog.map((designation) => (
                    <option key={designation.id} value={designation.title}>
                      {designation.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="employee-form-group">
                <label>Department</label>
                <select
                  name="departmentId"
                  value={orgForm.departmentId}
                  onChange={handleOrgFieldChange}
                >
                  <option value="">Not assigned</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="employee-form-group">
                <label>Reporting Manager</label>
                <select
                  name="reportingManagerId"
                  value={orgForm.reportingManagerId}
                  onChange={handleOrgFieldChange}
                >
                  <option value="">Not assigned</option>
                  {employees
                    .filter((candidate) =>
                      candidate.employment_status === "active" &&
                      candidate.id !== orgTarget.id
                    )
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.full_name} ({candidate.employee_id})
                      </option>
                    ))}
                </select>
                <span className="employee-form-help">
                  Validated server-side: no self-reporting, no circular
                  chains, and the manager must be an active user.
                </span>
              </div>

              {canManageSystemAccess && (
                <div className="employee-form-group">
                  <label>System Access</label>
                  <select
                    name="systemAccess"
                    value={orgForm.systemAccess}
                    onChange={handleOrgFieldChange}
                  >
                    <option value="employee">Employee</option>
                    <option value="team_lead">Team Lead</option>
                    <option value="manager">Manager</option>
                    <option value="department_head">Department Head</option>
                    <option value="hr">HR</option>
                    <option value="executive">Executive</option>
                    <option value="admin">Admin</option>
                    {currentUser?.systemAccess === "super_admin" && (
                      <option value="super_admin">Super Admin</option>
                    )}
                  </select>
                </div>
              )}

              {canManageSystemAccess && (
                <div className="employee-form-group">
                  <label>Project Access</label>
                  <select
                    name="projectAccess"
                    value={orgForm.projectAccess}
                    onChange={handleOrgFieldChange}
                  >
                    <option value="default">Default (based on designation)</option>
                    <option value="granted">Enabled — Granted</option>
                    <option value="revoked">Disabled — Revoked</option>
                  </select>
                  <span className="employee-form-help">
                    CEO, CTO, Tech Lead, Manager and Software Engineer have
                    Project access by default. Use this to grant access to
                    anyone else, or to revoke it from a default-access user.
                  </span>
                </div>
              )}

              {canManageSystemAccess && (
                <div className="employee-form-group">
                  <label>Project Access Level</label>
                  <select
                    name="projectAccessLevel"
                    value={orgForm.projectAccessLevel}
                    onChange={handleOrgFieldChange}
                  >
                    <option value="basic">Basic</option>
                    <option value="stakeholder">Stakeholder</option>
                  </select>
                  <span className="employee-form-help">
                    A ceiling on this user&apos;s capabilities inside EVERY
                    project, regardless of their security group there.
                    Stakeholder still cannot manage members, security,
                    or delete anything — this does not grant Project
                    access by itself; the user must still be added to a
                    project separately.
                  </span>
                </div>
              )}

              <div className="employee-modal-actions">
                <button
                  type="button"
                  className="cancel-employee-button"
                  onClick={() => setOrgTarget(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="save-employee-button"
                  disabled={orgSaving}
                >
                  {orgSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>

            </form>

          </div>
        </div>

      )}

      </>

    );

  }

export default Employees;