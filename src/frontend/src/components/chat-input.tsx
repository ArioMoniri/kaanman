"use client";

import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Square } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading?: boolean;
}

export function ChatInput({ onSend, isLoading = false }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxHeight = 200;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setValue("");
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <div className="rounded-3xl border border-border bg-surface p-3 shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-colors focus-within:border-border-light">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask a clinical question..."
        rows={1}
        className="w-full resize-none bg-transparent px-2 py-1.5 text-base text-gray-100 placeholder:text-gray-500 focus:outline-none min-h-[40px]"
        disabled={isLoading}
      />

      <div className="flex items-center justify-end pt-2">
        <button
          onClick={handleSubmit}
          disabled={isLoading || !hasContent}
          className={`
            h-8 w-8 rounded-full flex items-center justify-center transition-all duration-200
            ${hasContent && !isLoading
              ? "bg-white hover:bg-white/80 text-surface cursor-pointer"
              : "bg-transparent text-gray-600 cursor-default"
            }
            disabled:opacity-40
          `}
        >
          {isLoading ? (
            <Square className="h-3.5 w-3.5 fill-current animate-pulse" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
