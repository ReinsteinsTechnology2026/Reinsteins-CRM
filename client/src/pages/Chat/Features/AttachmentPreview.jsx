import "./AttachmentPreview.css";
import {
  FaFilePdf,
  FaFileWord,
  FaFileExcel,
  FaFilePowerpoint,
  FaFileArchive,
  FaFileAlt,
  FaFile,
} from "react-icons/fa";

function getFileIcon(name = "") {
  const file = name.toLowerCase();

  if (file.endsWith(".pdf")) return <FaFilePdf />;
  if (file.endsWith(".doc") || file.endsWith(".docx"))
    return <FaFileWord />;
  if (file.endsWith(".xls") || file.endsWith(".xlsx"))
    return <FaFileExcel />;
  if (file.endsWith(".ppt") || file.endsWith(".pptx"))
    return <FaFilePowerpoint />;
  if (file.endsWith(".zip") || file.endsWith(".rar"))
    return <FaFileArchive />;
  if (file.endsWith(".txt"))
    return <FaFileAlt />;

  return <FaFile />;
}

function AttachmentPreview({
  attachments,
  removeAttachment,
}) {
  if (!attachments.length) return null;

  return (
    <div className="attachment-preview-container">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="attachment-card"
        >
          {attachment.preview ? (
            <img
              src={attachment.preview}
              alt={attachment.file.name}
              className="attachment-image"
            />
          ) : (
            <div className="attachment-file-icon">
              {getFileIcon(
                attachment.file.name
              )}
            </div>
          )}

          <div className="attachment-details">
            <div className="attachment-name">
              {attachment.file.name}
            </div>

            <div className="attachment-size">
              {(attachment.file.size / 1024).toFixed(1)} KB
            </div>
          </div>

          <button
            className="attachment-remove"
            onClick={() =>
              removeAttachment(
                attachment.id
              )
            }
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export default AttachmentPreview;