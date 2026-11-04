"use client";

import { useCallback, useRef, useState } from "react";

type DropZoneProps = {
  accept: string;
  multiple?: boolean;
  label: string;
  hint: string;
  accent?: "blue" | "rust" | "gold";
  onFiles: (files: File[]) => void;
  compact?: boolean;
  children?: React.ReactNode;
};

export function DropZone({
  accept,
  multiple = false,
  label,
  hint,
  accent = "gold",
  onFiles,
  compact = false,
  children,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);

  const take = useCallback(
    (list: FileList | File[] | null) => {
      if (!list) return;
      const files = Array.from(list).filter((f) => f.size > 0);
      if (files.length) onFiles(multiple ? files : files.slice(0, 1));
    },
    [multiple, onFiles],
  );

  const ring =
    accent === "blue" ? "border-blue/30" : accent === "rust" ? "border-rust/30" : "border-gold/40";

  return (
    <div
      className={`relative cursor-pointer rounded-xl border-2 border-dashed ${ring} bg-white/50 transition ${
        over ? "drop-active" : "hover:bg-white"
      } ${compact ? "p-3" : "p-6"}`}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      {children ?? (
        <div className="text-center">
          <div className="text-sm font-medium text-ink">{label}</div>
          <div className="mt-1 text-xs text-muted">{hint}</div>
        </div>
      )}
    </div>
  );
}
