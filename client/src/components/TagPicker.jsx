import { useEffect, useRef, useState } from "react";

import { searchTags } from "../services/tagService";

import "./TagPicker.css";

const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_TASK = 10;

// ==========================================
// INTERACTIVE TAG PICKER
// Chips + "+ Add tag" input with autocomplete
// against the global tag dictionary. Purely local
// state -- value/onChange are plain string arrays,
// only sent to the server when the surrounding form
// is saved, matching how every other field on these
// forms already works.
// ==========================================

function TagPicker({ value, onChange, disabled }) {

    const names = value || [];

    const [inputValue, setInputValue] = useState("");

    const [suggestions, setSuggestions] = useState([]);

    const [showSuggestions, setShowSuggestions] = useState(false);

    const blurTimeout = useRef(null);

    useEffect(() => {

        const query = inputValue.trim();

        if (!query) {
            setSuggestions([]);
            return;
        }

        const timeout = setTimeout(async () => {

            try {

                const response = await searchTags(query);

                setSuggestions(response.tags || []);

            } catch (error) {

                console.error(error);

            }

        }, 200);

        return () => clearTimeout(timeout);

    }, [inputValue]);

    useEffect(() => {

        return () => {
            if (blurTimeout.current) {
                clearTimeout(blurTimeout.current);
            }
        };

    }, []);

    function addTag(rawName) {

        const trimmed = rawName.trim();

        if (!trimmed) {
            return;
        }

        if (trimmed.length > MAX_TAG_LENGTH) {
            return;
        }

        if (names.some((name) => name.toLowerCase() === trimmed.toLowerCase())) {
            setInputValue("");
            setShowSuggestions(false);
            return;
        }

        if (names.length >= MAX_TAGS_PER_TASK) {
            return;
        }

        onChange([...names, trimmed]);

        setInputValue("");
        setShowSuggestions(false);

    }

    function removeTag(name) {
        onChange(names.filter((existing) => existing !== name));
    }

    function handleKeyDown(event) {

        if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            addTag(inputValue);
        } else if (event.key === "Backspace" && !inputValue && names.length > 0) {
            removeTag(names[names.length - 1]);
        }

    }

    const atLimit = names.length >= MAX_TAGS_PER_TASK;

    const visibleSuggestions = suggestions.filter(
        (suggestion) => !names.some((name) => name.toLowerCase() === suggestion.name.toLowerCase())
    );

    if (disabled) {

        return (
            <div className="tag-picker tag-picker-readonly">
                {names.length === 0 ? (
                    <span className="tag-chip-empty">No tags</span>
                ) : (
                    <span className="tag-chip-group">
                        {names.map((name) => (
                            <span key={name} className="tag-chip">{name}</span>
                        ))}
                    </span>
                )}
            </div>
        );

    }

    return (

        <div className="tag-picker">

            <div className="tag-picker-chips">

                {names.map((name) => (

                    <span key={name} className="tag-chip">

                        {name}

                        <button
                            type="button"
                            className="tag-chip-remove"
                            onClick={() => removeTag(name)}
                            aria-label={`Remove ${name}`}
                        >
                            &times;
                        </button>

                    </span>

                ))}

                {!atLimit && (

                    <input
                        type="text"
                        className="tag-picker-input"
                        placeholder={names.length === 0 ? "Add tag..." : ""}
                        value={inputValue}
                        maxLength={MAX_TAG_LENGTH}
                        onChange={(event) => {
                            setInputValue(event.target.value);
                            setShowSuggestions(true);
                        }}
                        onKeyDown={handleKeyDown}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={() => {
                            blurTimeout.current = setTimeout(() => setShowSuggestions(false), 150);
                        }}
                    />

                )}

            </div>

            {atLimit && (
                <p className="tag-picker-hint">Maximum of {MAX_TAGS_PER_TASK} tags reached</p>
            )}

            {showSuggestions && visibleSuggestions.length > 0 && (

                <div className="tag-picker-suggestions">

                    {visibleSuggestions.map((suggestion) => (

                        <button
                            type="button"
                            key={suggestion.id}
                            className="tag-picker-suggestion"
                            onMouseDown={() => addTag(suggestion.name)}
                        >
                            {suggestion.name}
                        </button>

                    ))}

                </div>

            )}

        </div>

    );

}

export default TagPicker;
