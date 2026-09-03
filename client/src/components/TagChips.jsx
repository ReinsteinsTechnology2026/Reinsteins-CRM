import "./TagChips.css";

// ==========================================
// READ-ONLY TAG DISPLAY
// Renders up to `max` tag chips with a "+N"
// overflow indicator. Pass onRemove to render a
// remove control per chip (used inside TagPicker);
// omit it for plain display (TaskWorkspace,
// AdminTasksList, EmployeeTasks, Kanban cards).
// ==========================================

function TagChips({ tags, max, onRemove, emptyText }) {

    const list = tags || [];

    if (list.length === 0) {
        return emptyText ? <span className="tag-chip-empty">{emptyText}</span> : null;
    }

    const visible = max ? list.slice(0, max) : list;
    const overflow = max ? Math.max(0, list.length - max) : 0;

    return (
        <span className="tag-chip-group">

            {visible.map((tag) => (

                <span key={tag.id ?? tag.name} className="tag-chip">

                    {tag.name}

                    {onRemove && (
                        <button
                            type="button"
                            className="tag-chip-remove"
                            onClick={() => onRemove(tag)}
                            aria-label={`Remove ${tag.name}`}
                        >
                            &times;
                        </button>
                    )}

                </span>

            ))}

            {overflow > 0 && (
                <span className="tag-chip tag-chip-overflow" title={list.slice(max).map((t) => t.name).join(", ")}>
                    +{overflow}
                </span>
            )}

        </span>
    );

}

export default TagChips;
