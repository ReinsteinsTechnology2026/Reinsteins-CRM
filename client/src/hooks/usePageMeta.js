import { useEffect } from "react";

// Sets the document title and description for a public page and restores the previous values when it unmounts.
export default function usePageMeta(title, description) {
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
