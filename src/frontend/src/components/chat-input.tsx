"use client";

import React, { useState, useRef, useEffect } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square } from "lucide-react";
import { motion } from "framer-motion";

const cn = (...classes: (string | undefined | null | false)[]) =>
  classes.filter(Boolean).join(" ");

/* ---------- Tooltip ---------- */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md border border-[#333333] bg-[#1F2023] px-3 py-1.5 text-sm text-white shadow-md",
      "animate-in fade-in-0 zoom-in-95",
      className
    )}
    {...props}
  />
));
TooltipContent.displayName = "TooltipContent";

/* ---------- ChatInput ---------- */
interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel?: () => void;
  isLoading?: boolean;
  placeholder?: string;
}

export function ChatInput({
  onSend,
  onCancel,
  isLoading = false,
  placeholder = "Ask a clinical question...",
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxHeight = 240;

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
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <TooltipProvider>
      <div
        className={cn(
          "rounded-3xl border border-[#444444] bg-[#1F2023] p-2",
          "shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300",
          "focus-within:border-[#555555]"
        )}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={isLoading}
          className={cn(
            "flex w-full rounded-md border-none bg-transparent px-3 py-2.5",
            "text-base text-gray-100 placeholder:text-gray-400",
            "focus-visible:outline-none focus-visible:ring-0",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "min-h-[44px] resize-none"
          )}
        />

        {/* Actions bar */}
        <div className="flex items-center justify-end gap-2 p-0 pt-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                onClick={isLoading && onCancel ? onCancel : handleSubmit}
                disabled={!isLoading && !hasContent}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={cn(
                  "h-8 w-8 rounded-full inline-flex items-center justify-center",
                  "transition-all duration-200 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                  isLoading
                    ? "bg-red-500 hover:bg-red-400 text-white"
                    : hasContent
                      ? "bg-white hover:bg-white/80 text-[#1F2023]"
                      : "bg-transparent text-[#9CA3AF]"
                )}
              >
                {isLoading ? (
                  <Square className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isLoading ? "Cancel" : hasContent ? "Send message" : "Type a message"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
