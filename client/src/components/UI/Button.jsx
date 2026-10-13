import "./Button.css";

// Shared Button (Batch 1) -- reads only the portal-agnostic --ui-*
// tokens (styles/uiTokens.css), so it renders in WorkHub's emerald or
// Platform Owner's indigo automatically depending on which shell it's
// mounted inside. Standalone: not yet used by any existing page.

function Button({

  variant = "primary",

  size = "md",

  type = "button",

  disabled = false,

  className = "",

  children,

  ...rest

}) {

  const classes = [

    "ui-btn",

    `ui-btn-${variant}`,

    size === "sm" ? "ui-btn-sm" : "",

    className

  ].filter(Boolean).join(" ");

  return (

    <button

      type={type}

      className={classes}

      disabled={disabled}

      {...rest}

    >

      {children}

    </button>

  );

}

export default Button;
