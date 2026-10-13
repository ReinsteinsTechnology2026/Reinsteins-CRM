import "./Skeleton.css";

// Shared loading Skeleton (Batch 1). `aria-hidden` because a skeleton
// is decorative -- the real content it stands in for is what screen
// readers should eventually announce, not this placeholder.

function Skeleton({ width = "100%", height = "14px", radius, circle = false, className = "" }) {

  const style = {

    width,

    height,

    borderRadius: circle ? "50%" : (radius ?? "var(--ui-radius-sm)")

  };

  return (

    <span

      className={["ui-skeleton", className].filter(Boolean).join(" ")}

      style={style}

      aria-hidden="true"

    />

  );

}

export default Skeleton;
