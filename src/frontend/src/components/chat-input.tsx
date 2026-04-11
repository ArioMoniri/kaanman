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
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // wantListening: true when user toggled ON, false when user toggled OFF.
  // Distinguishes intentional stop from Chrome's auto-stop (silence timeout).
  const wantListeningRef = useRef(false);
  const networkRetryCountRef = useRef(0);
  const MAX_NETWORK_RETRIES = 2;

  // Detect support after hydration (window unavailable during SSR)
  useEffect(() => {
    const hasSR =
      "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
    // SpeechRecognition also requires a secure context (HTTPS or localhost)
    const isSecure =
      window.isSecureContext ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    setIsSupported(hasSR && isSecure);
    if (hasSR && !isSecure) {
      console.warn(
        "[Voice] SpeechRecognition requires HTTPS or localhost. Current origin:",
        location.origin
      );
    }
  }, []);

  const createRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    // Use browser locale — empty string causes Chrome to error immediately
    recognition.lang = navigator.language || "en-US";
    return recognition;
  }, []);

  const start = useCallback(() => {
    if (!isSupported || recognitionRef.current) return;
    wantListeningRef.current = true;
    networkRetryCountRef.current = 0;
    setError(null);

    const recognition = createRecognition();
    let finalTranscript = "";

    recognition.addEventListener("start", () => {
      setIsListening(true);
      setError(null);
      networkRetryCountRef.current = 0; // reset on successful start
    });

    recognition.addEventListener("result", (event) => {
      const e = event as SpeechRecognitionEvent;
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
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
    });

    recognition.addEventListener("error", (event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errCode = (event as any).error as string | undefined;
      // "aborted" = user stopped; "no-speech" = silence timeout — both normal
      if (errCode === "aborted" || errCode === "no-speech") return;

      // "network" = can't reach Google speech servers — retry a couple of times
      if (errCode === "network") {
        networkRetryCountRef.current += 1;
        if (
          networkRetryCountRef.current <= MAX_NETWORK_RETRIES &&
          wantListeningRef.current
        ) {
          console.warn(
            `[Voice] Network error, retrying (${networkRetryCountRef.current}/${MAX_NETWORK_RETRIES})...`
          );
          // The "end" event fires after error — the restart happens there
          return;
        }
        // Exhausted retries
        console.warn("[Voice] Network error persists after retries");
        setError(
          location.protocol === "https:" || location.hostname === "localhost"
            ? "Could not reach speech service — check your internet connection"
            : "Voice input requires HTTPS. Access via localhost or enable HTTPS."
        );
        wantListeningRef.current = false;
        recognitionRef.current = null;
        setIsListening(false);
        setInterim("");
        return;
      }

      // "not-allowed" = mic permission denied
      if (errCode === "not-allowed" || errCode === "service-not-allowed") {
        setError("Microphone access denied — check browser permissions");
      } else {
        setError(`Voice error: ${errCode}`);
      }
      console.warn("[Voice] SpeechRecognition error:", errCode);
      wantListeningRef.current = false;
      recognitionRef.current = null;
      setIsListening(false);
      setInterim("");
    });

    recognition.addEventListener("end", () => {
      // Chrome auto-stops continuous recognition after ~5-10s of silence.
      // If the user still wants to listen, auto-restart silently.
      if (wantListeningRef.current) {
        try {
          // Small delay before retry on network errors to avoid tight loop
          const delay = networkRetryCountRef.current > 0 ? 500 : 0;
          if (delay > 0) {
            setTimeout(() => {
              if (!wantListeningRef.current) return;
              try {
                recognition.start();
              } catch {
                wantListeningRef.current = false;
                recognitionRef.current = null;
                setIsListening(false);
                setInterim("");
              }
            }, delay);
          } else {
            recognition.start();
          }
          return; // keep isListening true
        } catch {
          // If restart fails (e.g., mic revoked), give up
        }
      }
      recognitionRef.current = null;
      setIsListening(false);
      setInterim("");
    });

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      wantListeningRef.current = false;
      recognitionRef.current = null;
    }
  }, [isSupported, onTranscript, createRecognition]);

  const stop = useCallback(() => {
    wantListeningRef.current = false; // signal onend NOT to restart
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
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

  const clearError = useCallback(() => setError(null), []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      if (rec) {
        try { rec.stop(); } catch { /* ignore */ }
      }
    };
  }, []);

  return { isListening, interim, isSupported, error, toggle, stop, clearError };
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
      {/* Voice error banner */}
      {voice.error && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-300">
          <span className="flex-1">{voice.error}</span>
          <button
            onClick={voice.clearError}
            className="shrink-0 text-red-400 hover:text-red-200 transition-colors text-xs font-medium"
          >
            Dismiss
          </button>
        </div>
      )}
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
