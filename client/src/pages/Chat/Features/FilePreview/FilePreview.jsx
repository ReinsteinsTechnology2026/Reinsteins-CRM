import React from "react";
import {
  FaFilePdf,
  FaFileWord,
  FaFileExcel,
  FaFilePowerpoint,
  FaFileArchive,
  FaFileAlt,
  FaFile,
  FaTimes,
} from "react-icons/fa";

import "./FilePreview.css";

const getIcon = (name = "") => {
  const file = name.toLowerCase();

  if (file.endsWith(".pdf")) return <FaFilePdf />;
  if (file.endsWith(".doc") || file.endsWith(".docx")) return <FaFileWord />;
  if (file.endsWith(".xls") || file.endsWith(".xlsx")) return <FaFileExcel />;
  if (file.endsWith(".ppt") || file.endsWith(".pptx")) return <FaFilePowerpoint />;
  if (file.endsWith(".zip") || file.endsWith(".rar")) return <FaFileArchive />;
  if (file.endsWith(".txt")) return <FaFileAlt />;

  return <FaFile />;
};

const formatSize = (bytes) => {
  if (!bytes) return "";

  if (bytes < 1024)
    return `${bytes} B`;

  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

function FilePreview({
  files = [],
  removeFile,
}) {
  if (!files.length) return null;

  return (
    <div className="file-preview-container">
      {files.map((file, index) => (
        <div
          key={index}
          className="file-preview-card"
        >
          <div className="file-icon">
            {getIcon(file.name)}
          </div>

          <div className="file-info">
            <div className="file-name">
              {file.name}
            </div>

            <div className="file-size">
              {formatSize(file.size)}
            </div>
          </div>

          <button
            className="remove-file-btn"
            onClick={() => removeFile(index)}
          >
            <FaTimes />
          </button>
        </div>
      ))}
    </div>
  );
}

export default FilePreview;