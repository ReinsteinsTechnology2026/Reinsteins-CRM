import { useEffect, useRef, useState } from "react";

import { FaSearch, FaTimes, FaUserFriends, FaBuilding, FaProjectDiagram, FaSitemap } from "react-icons/fa";

import api from "../../services/api";

import {
    searchMeetingParticipants,
    getMeetingAvailability,
    getParticipants,
} from "../../services/meetingService";

import { getProjects } from "../../services/projectService";
import { getProjectMembers } from "../../services/projectMemberService";
import { getOrganizations, getOrganizationMembers } from "../../services/organizationsService";

import "./ParticipantPicker.css";

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }
}

function formatClockTime(value) {

    if (!value) return "";

    const [hourStr, minuteStr] = value.split(":");
    const hour = Number(hourStr);
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;

    return `${hour12}:${minuteStr} ${suffix}`;

}

// Self-contained participant picker: individual search + department/
// project/organization group-select + non-blocking availability badges.
// Only ever ADDS participants -- pre-existing invitees (edit mode) are
// shown as a separate read-only list, since removal stays on the
// meeting details Participants panel (matches the backend's add-only
// updateMeeting semantics).

function ParticipantPicker({ meetingId, value, onChange, scheduledDate, startTime, endTime }) {

    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.role === "admin";

    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);

    const [departments, setDepartments] = useState([]);
    const [projects, setProjects] = useState([]);
    const [organizations, setOrganizations] = useState([]);

    const [activeGroupPanel, setActiveGroupPanel] = useState(null);

    const [alreadyInvited, setAlreadyInvited] = useState([]);
    const [availability, setAvailability] = useState({});

    // Guards against an older, slower search response overwriting a
    // newer one (e.g. the initial empty-query search resolving after
    // a since-typed search) -- always keep only the latest request's
    // results.
    const latestQueryRef = useRef(query);

    // Load already-invited participants when editing an existing meeting.
    useEffect(() => {

        if (!meetingId) return;

        let cancelled = false;

        getParticipants(meetingId)
            .then((response) => {

                if (cancelled) return;

                const invited = (response.participants || []).filter(
                    (p) => p.role !== "host"
                );

                setAlreadyInvited(invited);

            })
            .catch(() => {});

        return () => { cancelled = true; };

    }, [meetingId]);

    // Debounced individual search.
    useEffect(() => {

        const handle = setTimeout(() => {

            setSearching(true);

            const requestedQuery = query;
            latestQueryRef.current = requestedQuery;

            searchMeetingParticipants(query)
                .then((response) => {
                    if (latestQueryRef.current !== requestedQuery) return;
                    setResults(response.participants || []);
                })
                .catch(() => {
                    if (latestQueryRef.current !== requestedQuery) return;
                    setResults([]);
                })
                .finally(() => {
                    if (latestQueryRef.current !== requestedQuery) return;
                    setSearching(false);
                });

        }, 300);

        return () => clearTimeout(handle);

    }, [query]);

    // Non-blocking availability lookup for currently-selected people.
    useEffect(() => {

        if (value.length === 0 || !scheduledDate || !startTime || !endTime) {
            setAvailability({});
            return;
        }

        const handle = setTimeout(() => {

            getMeetingAvailability({
                userIds: value.map((p) => p.id),
                date: scheduledDate,
                startTime,
                endTime,
            })
                .then((response) => setAvailability(response.availability || {}))
                .catch(() => setAvailability({}));

        }, 300);

        return () => clearTimeout(handle);

    }, [value, scheduledDate, startTime, endTime]);

    function addPerson(person) {

        if (value.some((p) => p.id === person.id)) return;
        if (alreadyInvited.some((p) => p.user_id === person.id)) return;

        onChange([...value, person]);

    }

    function addMany(people) {

        const toAdd = people.filter(
            (person) =>
                !value.some((p) => p.id === person.id) &&
                !alreadyInvited.some((p) => p.user_id === person.id)
        );

        if (toAdd.length === 0) return;

        onChange([...value, ...toAdd]);

    }

    function removePerson(personId) {
        onChange(value.filter((p) => p.id !== personId));
    }

    async function openDepartmentPanel() {

        setActiveGroupPanel(activeGroupPanel === "department" ? null : "department");

        if (departments.length === 0) {
            try {
                const { data } = await api.get("/departments");
                setDepartments(data.departments || []);
            } catch (error) {
                setDepartments([]);
            }
        }

    }

    async function openProjectPanel() {

        setActiveGroupPanel(activeGroupPanel === "project" ? null : "project");

        if (projects.length === 0) {
            try {
                const response = await getProjects();
                setProjects(response.projects || []);
            } catch (error) {
                setProjects([]);
            }
        }

    }

    async function openOrganizationPanel() {

        setActiveGroupPanel(activeGroupPanel === "organization" ? null : "organization");

        if (organizations.length === 0) {
            try {
                const response = await getOrganizations();
                setOrganizations(response.organizations || []);
            } catch (error) {
                setOrganizations([]);
            }
        }

    }

    async function addDepartmentMembers(departmentId) {

        try {

            const { data } = await api.get(`/departments/${departmentId}/members`, {
                params: { limit: 200 },
            });

            const active = (data.members || [])
                .filter((m) => m.employment_status === "active")
                .map((m) => ({
                    id: m.id,
                    full_name: m.full_name,
                    email: m.email,
                    designation: m.designation,
                    department_name: null,
                }));

            addMany(active);

        } catch (error) {
            // Non-critical -- group-select is a convenience on top of
            // individual search, which still works if this fails.
        }

    }

    async function addProjectMembers(projectId) {

        try {

            const response = await getProjectMembers(projectId);

            const active = (response.members || [])
                .filter((m) => m.employment_status === "active")
                .map((m) => ({
                    id: m.user_id ?? m.id,
                    full_name: m.full_name,
                    email: m.email,
                    designation: m.designation,
                    department_name: null,
                }));

            addMany(active);

        } catch (error) {
            // Non-critical, same as above.
        }

    }

    async function addOrganizationMembers(organizationId) {

        try {

            const response = await getOrganizationMembers(organizationId);

            const active = (response.members || [])
                .filter((m) => m.employment_status === "active")
                .map((m) => ({
                    id: m.user_id,
                    full_name: m.full_name,
                    email: m.email,
                    designation: m.designation,
                    department_name: m.department_name,
                }));

            addMany(active);

        } catch (error) {
            // Non-critical, same as above.
        }

    }

    return (

        <div className="participant-picker">

            <label>Participants</label>

            <div className="participant-search-box">
                <FaSearch />
                <input
                    type="text"
                    placeholder="Search by name or email..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>

            {query.trim() && (

                <div className="participant-search-results">

                    {searching && <div className="participant-search-empty">Searching...</div>}

                    {!searching && results.length === 0 && (
                        <div className="participant-search-empty">No matching people found</div>
                    )}

                    {!searching && results.map((person) => (
                        <button
                            type="button"
                            key={person.id}
                            className="participant-search-result"
                            onClick={() => addPerson(person)}
                        >
                            <span className="participant-result-name">{person.full_name}</span>
                            <span className="participant-result-meta">
                                {person.designation || person.department_name || person.email}
                            </span>
                        </button>
                    ))}

                </div>

            )}

            <div className="participant-group-buttons">

                <button type="button" className="participant-group-btn" onClick={openDepartmentPanel}>
                    <FaBuilding /> Add Department
                </button>

                <button type="button" className="participant-group-btn" onClick={openProjectPanel}>
                    <FaProjectDiagram /> Add Project Members
                </button>

                {isAdmin && (
                    <button type="button" className="participant-group-btn" onClick={openOrganizationPanel}>
                        <FaSitemap /> Add Organization Members
                    </button>
                )}

            </div>

            {activeGroupPanel === "department" && (
                <div className="participant-group-panel">
                    {departments.length === 0 && <span className="participant-search-empty">Loading...</span>}
                    {departments.map((dept) => (
                        <button
                            type="button"
                            key={dept.id}
                            className="participant-group-option"
                            onClick={() => addDepartmentMembers(dept.id)}
                        >
                            {dept.name}
                        </button>
                    ))}
                </div>
            )}

            {activeGroupPanel === "project" && (
                <div className="participant-group-panel">
                    {projects.length === 0 && <span className="participant-search-empty">Loading...</span>}
                    {projects.map((project) => (
                        <button
                            type="button"
                            key={project.id}
                            className="participant-group-option"
                            onClick={() => addProjectMembers(project.id)}
                        >
                            {project.name}
                        </button>
                    ))}
                </div>
            )}

            {activeGroupPanel === "organization" && (
                <div className="participant-group-panel">
                    {organizations.length === 0 && <span className="participant-search-empty">Loading...</span>}
                    {organizations.map((org) => (
                        <button
                            type="button"
                            key={org.id}
                            className="participant-group-option"
                            onClick={() => addOrganizationMembers(org.id)}
                        >
                            {org.name}
                        </button>
                    ))}
                </div>
            )}

            {alreadyInvited.length > 0 && (

                <div className="participant-chip-section">

                    <span className="participant-chip-section-label">
                        <FaUserFriends /> Already invited
                    </span>

                    <div className="participant-chip-list">
                        {alreadyInvited.map((p) => (
                            <div className="participant-chip participant-chip-readonly" key={p.user_id}>
                                {p.full_name}
                            </div>
                        ))}
                    </div>

                </div>

            )}

            {value.length > 0 && (

                <div className="participant-chip-section">

                    <span className="participant-chip-section-label">New invitees</span>

                    <div className="participant-chip-list">

                        {value.map((person) => {

                            const status = availability[person.id];

                            return (

                                <div className="participant-chip" key={person.id}>

                                    <span className="participant-chip-name">{person.full_name}</span>

                                    {status && (
                                        status.busy ? (
                                            <span className="participant-availability busy">
                                                🔴 Busy {status.conflicts[0] && `${formatClockTime(String(status.conflicts[0].start_time).substring(0, 5))} – ${formatClockTime(String(status.conflicts[0].end_time).substring(0, 5))}`}
                                            </span>
                                        ) : (
                                            <span className="participant-availability available">🟢 Available</span>
                                        )
                                    )}

                                    <button
                                        type="button"
                                        className="participant-chip-remove"
                                        onClick={() => removePerson(person.id)}
                                        aria-label={`Remove ${person.full_name}`}
                                    >
                                        <FaTimes />
                                    </button>

                                </div>

                            );

                        })}

                    </div>

                </div>

            )}

        </div>

    );

}

export default ParticipantPicker;
