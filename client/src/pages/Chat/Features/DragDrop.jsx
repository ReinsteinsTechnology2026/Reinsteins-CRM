import { useState } from "react";

function DragDrop({
  children,
  onImageDrop,
}) {
  const [dragging, setDragging] =
    useState(false);

  const handleDragOver = (event) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    setDragging(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();

    setDragging(false);

    const files = Array.from(
      event.dataTransfer.files
    ).filter((file) =>
      file.type.startsWith("image/")
    );

    if (!files.length) return;

    onImageDrop(files);
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
      }}
    >
      {children}

      {dragging && (
        <div
      style={{
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  minWidth: 0,
  position: "relative",
  overflow: "hidden",
}}
        >
          📎 Drop images here
        </div>
      )}
    </div>
  );
}

export default DragDrop;