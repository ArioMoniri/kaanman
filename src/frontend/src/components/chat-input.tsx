"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square, Mic, MicOff } from "lucide-react";
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

/* ---------- Voice Input Hook ---------- */
function useVoiceInput(onTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Detect support after hydration (window unavailable during SSR)
  useEffect(() => {
    setIsSupported(
      "SpeechRecognition" in window || "webkitSpeechRecognition" in window
    );
  }, []);

  const start = useCallback(() => {
    if (!isSupported) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = ""; // auto-detect

    let finalTranscript = "";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + " ";
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText);
      if (finalTranscript.trim()) {
        onTranscript(finalTranscript.trim());
        finalTranscript = "";
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
      setInterim("");
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterim("");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isSupported, onTranscript]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
    setInterim("");
  }, []);

  const toggle = useCallback(() => {
    if (isListening) {
      stop();
    } else {
      start();
    }
  }, [isListening, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  return { isListening, interim, isSupported, toggle, stop };
}

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

  const handleVoiceTranscript = useCallback((text: string) => {
    setValue((prev) => (prev ? prev + " " + text : text));
  }, []);

  const voice = useVoiceInput(handleVoiceTranscript);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    voice.stop();
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
          "flex items-end gap-2 rounded-3xl border border-[#444444] bg-[#1F2023] px-3 py-2",
          "shadow-[0_8px_30px_rgba(0,0,0,0.24)] transition-all duration-300",
          "focus-within:border-[#555555]",
          voice.isListening && "border-red-500/50 shadow-[0_0_20px_rgba(239,68,68,0.15)]"
        )}
      >
        {/* Voice input button */}
        {voice.isSupported && (
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.button
                onClick={voice.toggle}
                disabled={isLoading}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={cn(
                  "h-9 w-9 shrink-0 mb-1 rounded-full inline-flex items-center justify-center",
                  "transition-all duration-200 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                  voice.isListening
                    ? "bg-red-500/20 text-red-400 animate-pulse"
                    : "bg-transparent text-[#9CA3AF] hover:text-gray-200"
                )}
              >
                {voice.isListening ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {voice.isListening ? "Stop recording" : "Voice input"}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Textarea */}
        <div className="flex-1 flex flex-col">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={voice.isListening ? "Listening..." : placeholder}
            rows={1}
            disabled={isLoading}
            className={cn(
              "flex-1 rounded-md border-none bg-transparent px-1 py-2.5",
              "text-[16px] text-gray-100 placeholder:text-gray-400",
              "focus-visible:outline-none focus-visible:ring-0",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "min-h-[44px] resize-none",
              voice.isListening && "placeholder:text-red-400/60"
            )}
          />
          {/* Interim transcription preview */}
          {voice.isListening && voice.interim && (
            <div className="px-1 pb-1 text-sm text-gray-400 italic truncate">
              {voice.interim}
            </div>
          )}
        </div>

        {/* Send / Cancel button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              onClick={isLoading && onCancel ? onCancel : handleSubmit}
              disabled={!isLoading && !hasContent}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className={cn(
                "h-9 w-9 shrink-0 mb-1 rounded-full inline-flex items-center justify-center",
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
    </TooltipProvider>
  );
}
