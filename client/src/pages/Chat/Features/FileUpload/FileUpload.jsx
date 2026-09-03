import React from "react";
import { FaPaperclip } from "react-icons/fa";
import "./FileUpload.css";

const ALLOWED_FILES = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".zip",
  ".rar",
];

function FileUpload({ onFilesSelected }) {
  const handleChange = (e) => {
    const files = Array.from(e.target.files || []);

    if (files.length === 0) return;

    onFilesSelected(files);

    e.target.value = "";
  };

  return (
    <>
      <label
        htmlFor="chat-file-upload"
        className="chat-file-upload-btn"
        title="Attach Document"
      >
        <FaPaperclip />
      </label>

      <input
        id="chat-file-upload"
        type="file"
        multiple
        accept={ALLOWED_FILES.join(",")}
        onChange={handleChange}
        hidden
      />
    </>
  );
}

export default FileUpload;