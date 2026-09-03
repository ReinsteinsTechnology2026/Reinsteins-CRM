import { useEffect, useState } from "react";
import {
  FaTimes,
  FaSearchPlus,
  FaSearchMinus,
  FaDownload,
} from "react-icons/fa";

import "./ImageViewer.css";

function ImageViewer({
  image,
  open,
  onClose,
}) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) {
      setZoom(1);
    }
  }, [open]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKey);

    return () =>
      window.removeEventListener(
        "keydown",
        handleKey
      );
  }, [onClose]);

  if (!open) return null;

  const zoomIn = () =>
    setZoom((z) => Math.min(z + 0.2, 5));

  const zoomOut = () =>
    setZoom((z) => Math.max(z - 0.2, 0.5));

const downloadImage = async () => {
  try {
    const response = await fetch(image);

    const blob = await response.blob();

    const url = window.URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;

    const fileName =
      image.split("/").pop() || "image.jpg";

    link.download = fileName;

    document.body.appendChild(link);

    link.click();

    link.remove();

    window.URL.revokeObjectURL(url);

  } catch (error) {
    console.error("Download failed", error);
  }
};

  return (
    <div
      className="workhub-image-viewer-overlay"
      onClick={onClose}
    >
      <div
        className="workhub-image-viewer-container"
        onClick={(e) =>
          e.stopPropagation()
        }
      >
        <div className="workhub-image-viewer-toolbar">

          <button onClick={zoomIn}>
            <FaSearchPlus />
          </button>

          <button onClick={zoomOut}>
            <FaSearchMinus />
          </button>

          <button onClick={downloadImage}>
            <FaDownload />
          </button>

          <button onClick={onClose}>
            <FaTimes />
          </button>

        </div>

        <img
          src={image}
          alt="Preview"
          className="workhub-image-viewer-image"
          style={{
            transform: `scale(${zoom})`,
          }}
        />

      </div>
    </div>
  );
}

export default ImageViewer;