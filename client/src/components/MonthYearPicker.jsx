import { useEffect, useRef, useState } from "react";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";

import { MIN_PICKER_YEAR, MAX_PICKER_YEAR, monthShortLabels } from "../utils/shiftViews";

import "./MonthYearPicker.css";

// ==========================================
// MONTH / YEAR PICKER
// A small popover: a year with previous/next arrows and the twelve months of that year.
// Choosing a month calls onSelect(year, monthIndex) (monthIndex 0-11); the parent decides
// what that means and closes the popover. No library: <input type="month"> has no
// picker in Firefox or desktop Safari, so it cannot be relied on.
//
// Keyboard: Tab / Shift+Tab move between controls, the arrow keys move around the month
// grid, Enter / Space choose, Esc closes. A click outside `containerRef` (the element that
// holds the trigger and this popover) closes it too.
// ==========================================

const MONTH_SHORT = monthShortLabels();
const MONTH_LONG = Array.from({ length: 12 }, (_, i) => new Date(2026, i, 1).toLocaleDateString("en-IN", { month: "long" }));

const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };

function MonthYearPicker({ year, month, onSelect, onClose, containerRef }) {
    // The year being browsed; starts at the year of the month on screen.
    const [shownYear, setShownYear] = useState(year);
    const panelRef = useRef(null);
    const today = new Date();

    // Move focus into the picker (the chosen month when it is in view).
    useEffect(() => {
        const panel = panelRef.current;
        const target = panel && (panel.querySelector('[data-selected="true"]') || panel.querySelector(".shift-month-option"));
        if (target) target.focus();
    }, []);

    useEffect(() => {
        const handleKey = (event) => {
            if (event.key === "Escape") onClose();
        };
        const handlePointer = (event) => {
            const box = (containerRef && containerRef.current) || panelRef.current;
            if (box && !box.contains(event.target)) onClose();
        };

        document.addEventListener("keydown", handleKey);
        document.addEventListener("mousedown", handlePointer);

        return () => {
            document.removeEventListener("keydown", handleKey);
            document.removeEventListener("mousedown", handlePointer);
        };
    }, [onClose, containerRef]);

    const handleGridKeyDown = (event) => {
        const step = ARROW_STEPS[event.key];
        if (step === undefined) return;

        const buttons = Array.from(panelRef.current.querySelectorAll(".shift-month-option"));
        const next = buttons[buttons.indexOf(document.activeElement) + step];

        if (next) {
            event.preventDefault();
            next.focus();
        }
    };

    return (
        <div className="shift-month-picker" role="dialog" aria-label="Choose month and year" ref={panelRef}>
            <div className="shift-month-picker-year">
                <button
                    type="button"
                    className="shift-month-picker-step"
                    aria-label="Previous year"
                    disabled={shownYear <= MIN_PICKER_YEAR}
                    onClick={() => setShownYear((current) => current - 1)}
                >
                    <FaChevronLeft />
                </button>
                <span className="shift-month-picker-year-label" aria-live="polite">{shownYear}</span>
                <button
                    type="button"
                    className="shift-month-picker-step"
                    aria-label="Next year"
                    disabled={shownYear >= MAX_PICKER_YEAR}
                    onClick={() => setShownYear((current) => current + 1)}
                >
                    <FaChevronRight />
                </button>
            </div>

            <div className="shift-month-picker-grid" role="group" aria-label={`Months of ${shownYear}`} onKeyDown={handleGridKeyDown}>
                {MONTH_SHORT.map((label, index) => {
                    const selected = shownYear === year && index === month;
                    const isToday = shownYear === today.getFullYear() && index === today.getMonth();

                    return (
                        <button
                            key={label}
                            type="button"
                            className={`shift-month-option${selected ? " selected" : ""}${isToday ? " current" : ""}`}
                            aria-label={`${MONTH_LONG[index]} ${shownYear}`}
                            aria-pressed={selected}
                            aria-current={isToday ? "date" : undefined}
                            data-selected={selected ? "true" : undefined}
                            onClick={() => onSelect(shownYear, index)}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default MonthYearPicker;
