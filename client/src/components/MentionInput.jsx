import { useEffect, useRef, useState } from "react";

import { getMentionableUsers } from "../services/taskActivityService";

import "./MentionInput.css";

// ==========================================
// MENTION INPUT
//
// A plain textarea that detects "@name"
// while typing and shows a matching-user
// dropdown. Selecting a user inserts their
// full name and tracks their id so the
// parent can submit mentionedUserIds
// alongside the comment text.
// ==========================================

function MentionInput({

    value,

    onChange,

    placeholder,

    rows = 4,

    disabled = false

}) {

    const [users, setUsers] = useState([]);

    const [selectedMentions, setSelectedMentions] = useState([]);

    const [showDropdown, setShowDropdown] = useState(false);

    const [matches, setMatches] = useState([]);

    const textareaRef = useRef(null);

    useEffect(() => {

        loadUsers();

    }, []);

    async function loadUsers() {

        try {

            const response = await getMentionableUsers();

            setUsers(response.users || []);

        } catch (error) {

            console.error("Unable to load mentionable users:", error);

        }

    }

    // ==========================================
    // COMPUTE mentionedUserIds FROM CURRENT TEXT
    // Only mentions still present as "@FullName"
    // in the text are counted.
    // ==========================================

    function emitChange(nextText, mentions) {

        const activeIds = mentions
            .filter((mention) => nextText.includes(`@${mention.fullName}`))
            .map((mention) => mention.id);

        onChange({
            text: nextText,
            mentionedUserIds: [...new Set(activeIds)],
        });

    }

    function handleTextChange(event) {

        const nextText = event.target.value;

        const cursor = event.target.selectionStart;

        const beforeCursor = nextText.slice(0, cursor);

        const mentionMatch = beforeCursor.match(/@([^\s@]*)$/);

        if (mentionMatch) {

            const query = mentionMatch[1].toLowerCase();

            const filtered = users.filter((user) =>
                user.full_name.toLowerCase().includes(query)
            );

            setMatches(filtered);

            setShowDropdown(filtered.length > 0);

        } else {

            setShowDropdown(false);

        }

        emitChange(nextText, selectedMentions);

    }

    function handleSelectMention(user) {

        const cursor = textareaRef.current?.selectionStart ?? value.length;

        const beforeCursor = value.slice(0, cursor);

        const afterCursor = value.slice(cursor);

        const replacedBefore = beforeCursor.replace(
            /@([^\s@]*)$/,
            `@${user.full_name} `
        );

        const nextText = replacedBefore + afterCursor;

        const nextMentions = [
            ...selectedMentions.filter((mention) => mention.id !== user.id),
            { id: user.id, fullName: user.full_name },
        ];

        setSelectedMentions(nextMentions);

        setShowDropdown(false);

        emitChange(nextText, nextMentions);

        requestAnimationFrame(() => {
            textareaRef.current?.focus();
        });

    }

    return (

        <div className="mention-input-wrapper">

            <textarea
                ref={textareaRef}
                className="mention-input-textarea"
                rows={rows}
                placeholder={placeholder}
                value={value}
                onChange={handleTextChange}
                disabled={disabled}
            />

            {showDropdown && (

                <div className="mention-input-dropdown">

                    {matches.map((user) => (

                        <button
                            type="button"
                            key={user.id}
                            className="mention-input-option"
                            onClick={() => handleSelectMention(user)}
                        >

                            <span className="mention-input-avatar">
                                {user.full_name?.charAt(0).toUpperCase()}
                            </span>

                            <span>
                                <strong>{user.full_name}</strong>
                                <small>{user.role === "admin" ? "Administrator" : "Employee"}</small>
                            </span>

                        </button>

                    ))}

                </div>

            )}

        </div>

    );

}

export default MentionInput;
