const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "👏", "🎉", "😢", "😡"];

// ==========================================
// REACTION PICKER
// Small popover attached to the control bar's
// reaction button. Selecting one broadcasts it
// (transient, Socket.IO only — never stored).
// ==========================================

export function ReactionPicker({ onReact, onCloseRequest }) {

    return (

        <div className="meeting-reaction-picker" role="menu">

            {REACTION_EMOJIS.map((emoji) => (

                <button
                    key={emoji}
                    type="button"
                    className="meeting-reaction-option"
                    onClick={() => {
                        onReact(emoji);
                        onCloseRequest();
                    }}
                    aria-label={`React with ${emoji}`}
                    title={emoji}
                >
                    {emoji}
                </button>

            ))}

        </div>

    );

}

// ==========================================
// FLOATING REACTIONS OVERLAY
// Purely a render of whatever transient
// reaction list MeetingRoom.jsx is currently
// holding — it owns adding/expiring entries.
// ==========================================

export function FloatingReactions({ reactions }) {

    if (reactions.length === 0) return null;

    return (

        <div className="meeting-reactions-overlay" aria-hidden="true">

            {reactions.map((reaction) => (

                <span
                    key={reaction.id}
                    className="meeting-floating-reaction"
                    style={{ left: `${reaction.offset}%` }}
                >
                    {reaction.emoji}
                </span>

            ))}

        </div>

    );

}

export default REACTION_EMOJIS;
