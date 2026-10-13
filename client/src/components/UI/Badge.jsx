import "./Badge.css";

// Shared Badge (Batch 1) -- same --ui-* token pattern as Button.
// "pending" is deliberately not offered as a tone: Platform Owner has
// a --p-pending token but WorkHub's theme.css has no equivalent
// semantic color, and this component must not invent one.

function Badge({ tone = "neutral", children, className = "" }) {

  const classes = [

    "ui-badge",

    `ui-badge-${tone}`,

    className

  ].filter(Boolean).join(" ");

  return (

    <span className={classes}>
      {children}
    </span>

  );

}

export default Badge;
