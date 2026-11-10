import { useEffect, useRef, useState } from "react";

// ==========================================
// PUBLIC WEBSITE MOTION HELPERS
// IntersectionObserver based, no animation library. When the visitor asks for reduced motion, or the browser has no
// IntersectionObserver, everything is simply shown in its final state.
// ==========================================

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Returns [ref, inView]. `inView` turns true once and stays true.
export function useInView({ threshold = 0.18, rootMargin = "0px 0px -8% 0px" } = {}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  return [ref, inView];
}

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

// Sets the document title and description for a public page and restores the previous values when it unmounts.
export function usePageMeta(title, description) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    let tag = document.querySelector('meta[name="description"]');
    const previousDescription = tag ? tag.getAttribute("content") : null;
    if (description) {
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("name", "description");
        document.head.appendChild(tag);
      }
      tag.setAttribute("content", description);
    }
    return () => {
      document.title = previousTitle;
      if (tag && previousDescription !== null) tag.setAttribute("content", previousDescription);
    };
  }, [title, description]);
}
