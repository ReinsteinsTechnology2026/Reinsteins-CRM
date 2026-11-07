// Hands a decrypted file to the browser as a plain download. It is ALWAYS given the neutral type "application/octet-stream" and a cleaned name
// (never the type the uploader claimed), is never opened inline and never rendered in the page, so a hostile file cannot run in the CRM.
// The temporary link is revoked at once.
export function saveBytes(name, bytes) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") throw new Error("Saving files is not available in this browser.");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
