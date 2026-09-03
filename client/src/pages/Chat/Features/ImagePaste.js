import { useEffect } from "react";

function useImagePaste(addAttachments) {
  useEffect(() => {
    const handlePaste = (event) => {
      const items = event.clipboardData?.items;

      if (!items) return;

      const files = [];

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();

          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length) {
        event.preventDefault();
        addAttachments(files);
      }
    };

    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [addAttachments]);
}

export default useImagePaste;