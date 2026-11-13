import { useEffect, useState } from "react";

import { useInView, prefersReducedMotion } from "../../hooks/useInView";

// ==========================================
// PUBLIC WEBSITE MOTION COMPONENTS
// IntersectionObserver based (see hooks/useInView.js), no animation library. With reduced motion, or without IntersectionObserver,
// everything is shown in its final state.
// ==========================================

// Fades and lifts its children in when scrolled into view. `delay` (ms) staggers siblings.
export function Reveal({ as: Tag = "div", delay = 0, className = "", children, ...rest }) {
  const [ref, inView] = useInView();
  return (
    <Tag
      ref={ref}
      className={`ws-reveal${inView ? " is-in" : ""}${className ? ` ${className}` : ""}`}
      style={{ "--ws-delay": `${delay}ms` }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

// Counts up to `end` once visible. Only use it for values that are real and verifiable.
export function CountUp({ end, duration = 1100 }) {
  const [ref, inView] = useInView({ threshold: 0.4 });
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView) return undefined;
    if (prefersReducedMotion()) {
      setValue(end);
      return undefined;
    }
    let frame;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      setValue(Math.round(end * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, end, duration]);

  return <span ref={ref}>{inView ? value : 0}</span>;
}
